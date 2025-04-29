const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const usersRouter = require('./routes/users');

const port = process.env.PORT || 3001;

const app = express();



const corsOptions = {
  origin: ['https://leetcode-dashboard-zeta.vercel.app','http://localhost:5173', 'https://leetcode-server-seven.vercel.app'], 
  methods: ['GET', 'POST', 'DELETE'],  
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Use the users router for all /api routes
app.use('/api', usersRouter);

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000 // limit each IP to 1000 requests per windowMs
});
app.use(limiter);

// LeetCode GraphQL API endpoint
const LEETCODE_API_ENDPOINT = 'https://leetcode.com/graphql';

// GraphQL queries
const contestQuery = `
query getUserContestRanking ($username: String!) {
    userContestRanking(username: $username) {
        rating
    }
}`;

// Format contest data
const formatContestData = (data) => ({
  contestRating: data.userContestRanking?.rating || 'N/A'
});

// Routes

app.get('/', (req, res) => {
  res.send('Welcome to the LeetCode Backend!');
});

app.get('/api/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    // Fetch both user data and contest data in parallel
    const [userResponse, contestResponse] = await Promise.all([
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
      })
    ]);
    
    const problemsByDifficulty = userResponse.data.data.matchedUser.submitStats.acSubmissionNum;
    const contestRating = contestResponse.data.data.userContestRanking?.rating;
    
    const customScore = calculateCustomScore(contestRating, problemsByDifficulty);
    
    res.json({ customScore });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching user data' });
  }
});

app.get('/api/problems/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const response = await axios.post(LEETCODE_API_ENDPOINT, {
      query: `
        query getUserProblemsSolved($username: String!) {
          allQuestionsCount {
            difficulty
            count
          }
          matchedUser(username: $username) {
            submitStatsGlobal {
              acSubmissionNum {
                difficulty
                count
              }
            }
          }
        }
      `,
      variables: { username }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching problem statistics' });
  }
});

app.get('/api/contest/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const response = await axios.post(LEETCODE_API_ENDPOINT, {
      query: contestQuery,
      variables: { username }
    });

    if (response.data.errors) {
      return res.status(400).json(response.data);
    }

    return res.json(formatContestData(response.data.data));
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to fetch contest data' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});