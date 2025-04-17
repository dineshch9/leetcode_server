const express = require('express');
const axios = require('axios');
const router = express.Router();

const LEETCODE_API_ENDPOINT = 'https://leetcode.com/graphql';

const contestQuery = `
query getUserContestRanking ($username: String!) {
    userContestRanking(username: $username) {
        rating
    }
}`;

const calculateCustomScore = (contestRating, problemsByDifficulty) => {
  const alpha = 60; // Weight for rating
  const beta = 0.45; // Weight for problems solved
  const normalizedRating = (contestRating || 0) / 3000;
  
  const easy = problemsByDifficulty.find(item => item.difficulty === 'Easy')?.count || 0;
  const medium = problemsByDifficulty.find(item => item.difficulty === 'Medium')?.count || 0;
  const hard = problemsByDifficulty.find(item => item.difficulty === 'Hard')?.count || 0;
  
  const problemScore = easy + 2.5 * medium + 4 * hard;
  return Math.round(alpha * normalizedRating + beta * problemScore);
};

// Get score for a single user
router.get('/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    // Fetch user data, contest data, and recent accepted submission in parallel
    const [userResponse, contestResponse, recentAcResponse] = await Promise.all([
      axios.post(LEETCODE_API_ENDPOINT, {
        query: `
          query getUserProfile($username: String!) {
            matchedUser(username: $username) {
              submitStats {
                acSubmissionNum {
                  difficulty
                  count
                }
              }
            }
          }
        `,
        variables: { username }
      }),
      axios.post(LEETCODE_API_ENDPOINT, {
        query: contestQuery,
        variables: { username }
      }),
      axios.post(LEETCODE_API_ENDPOINT, {
        query: `
          query getACSubmissions($username: String!, $limit: Int) {
            recentAcSubmissionList(username: $username, limit: 1) {
              title
              titleSlug
              timestamp
              statusDisplay
              lang
            }
          }
        `,
        variables: { username, limit: 1 }
      })
    ]);

    const problemsByDifficulty = userResponse.data.data?.matchedUser?.submitStats?.acSubmissionNum || [];
    const contestRating = contestResponse.data.data?.userContestRanking?.rating;
    let recentActiveDate = 'NA';
    const submissions = recentAcResponse.data.data?.recentAcSubmissionList;
    if (Array.isArray(submissions) && submissions.length > 0 && submissions[0] && submissions[0].timestamp) {
      const date = new Date(submissions[0].timestamp * 1000);
      recentActiveDate = date.toISOString().split('T')[0];
    }
    const customScore = calculateCustomScore(contestRating, problemsByDifficulty);
    res.json({ username, customScore, recentActiveDate });
  } catch (error) {
    console.error('Error in /user/:username:', error);
  
    res.status(500).json({ error: 'Error fetching user data' });
  }
});

// Get scores for multiple users
router.post('/users/scores', async (req, res) => {
  const { usernames } = req.body;
  
  if (!Array.isArray(usernames)) {
    return res.status(400).json({ error: 'Usernames must be provided as an array' });
  }

  // Batching and throttling logic
  const BATCH_SIZE = 10; // Number of concurrent requests
  const DELAY_MS = 50; // Delay between batches

  async function processInBatches(items, batchSize, handler) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(handler));
      results.push(...batchResults);
      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }
    return results;
  }

  // Retry wrapper for user fetch
  async function fetchWithRetry(username, handler, retries = 2, delayMs = 200) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await handler(username);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await delay(delayMs);
      }
    }
    // If all retries failed, return error object
    return {
      username,
      customScore: 0,
      recentActiveDate: 'NA',
      isActive: false,
      userNotFound: false,
      error: lastErr ? (lastErr.message || 'Failed after retries') : 'Unknown error'
    };
  }

  try {
    const now = Date.now();
    let activeCount = 0;
    const handler = async username => {
      try {
        const [userResponse, contestResponse, recentAcResponse] = await Promise.all([
          axios.post(LEETCODE_API_ENDPOINT, {
            query: `\n            query getUserProfile($username: String!) {\n              matchedUser(username: $username) {\n                submitStats {\n                  acSubmissionNum {\n                    difficulty\n                    count\n                  }\n                }\n              }\n            }\n          `,
            variables: { username }
          }),
          axios.post(LEETCODE_API_ENDPOINT, {
            query: contestQuery,
            variables: { username }
          }),
          axios.post(LEETCODE_API_ENDPOINT, {
            query: `\n            query getACSubmissions($username: String!) {\n              recentAcSubmissionList(username: $username, limit: 1) {\n                id\n                title\n                timestamp\n              }\n            }\n          `,
            variables: { username }
          })
        ]);

        // Enhanced user existence check
        const matchedUser = userResponse.data.data?.matchedUser;
        const problemsByDifficulty = matchedUser?.submitStats?.acSubmissionNum || [];
        const contestRating = contestResponse.data.data?.userContestRanking?.rating;
        let recentActiveDate = 'NA';
        let isActive = false;
        const submissions = recentAcResponse.data.data?.recentAcSubmissionList;
        if (!matchedUser) {
          return {
            username,
            customScore: 'User Not Found',
            recentActiveDate: 'User Not Found',
            isActive: false,
            userNotFound: true,
            error: 'User does not exist on LeetCode'
          };
        }
        if (Array.isArray(submissions) && submissions.length > 0 && submissions[0] && submissions[0].timestamp) {
          const date = new Date(submissions[0].timestamp * 1000);
          recentActiveDate = date.toISOString().split('T')[0];
          if ((now - date.getTime()) <= 7 * 24 * 60 * 60 * 1000) {
            isActive = true;
          }
        }
        if (isActive) activeCount++;
        return {
          username,
          customScore: calculateCustomScore(contestRating, problemsByDifficulty),
          recentActiveDate,
          isActive
        };
      } catch (err) {
        // Distinguish between user not found and other errors
        let userNotFound = false;
        let errorMsg = err.message || 'Failed to fetch user data';
        if (err.response && err.response.data && err.response.data.errors) {
          const errors = err.response.data.errors;
          if (Array.isArray(errors) && errors.some(e => (e.message || '').toLowerCase().includes('not found'))) {
            userNotFound = true;
            errorMsg = 'User does not exist on LeetCode';
          }
        }
        return {
          username,
          customScore: userNotFound ? 'User Not Found' : 0,
          recentActiveDate: userNotFound ? 'User Not Found' : 'NA',
          isActive: false,
          userNotFound,
          error: errorMsg
        };
      }
    };

    // Use retry logic for each user
    const scores = await processInBatches(usernames, BATCH_SIZE, username => fetchWithRetry(username, handler, 2, 200));
    res.json({
      total: usernames.length,
      active: scores.filter(u => u.isActive).length,
      scores
    });
  } catch (error) {
    console.error('Error in /users/scores:', error);

    res.status(500).json({ error: 'Error fetching user data' });
  }
});

module.exports = router;