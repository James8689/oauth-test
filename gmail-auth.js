'use strict'

require('dotenv').config()
const fastify = require('fastify')({ 
  logger: { level: 'trace' },
  connectionTimeout: 0, // No timeout
  keepAliveTimeout: 5000,
  pluginTimeout: 120000
})
const path = require('path')
const fs = require('fs')
const oauthPlugin = require('@fastify/oauth2')
const emailProcessor = require('./email-processor')

// Add global fetch support if using Node.js before v18
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Create data directory for storing tokens
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Register cookie plugin for session management
fastify.register(require('@fastify/cookie'), {
  secret: process.env.SESSION_SECRET
})

// First add the session plugin for state management
fastify.register(require('@fastify/session'), {
  cookieName: 'session',
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 60 * 1000 // 30 minutes
  }
})

// Register the OAuth plugin with Google credentials and Gmail scope
fastify.register(oauthPlugin, {
  name: 'googleOAuth2',
  credentials: {
    client: {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET
    },
    auth: oauthPlugin.GOOGLE_CONFIGURATION
  },
  // Scope for Gmail access
  scope: ['https://www.googleapis.com/auth/gmail.readonly', 'profile', 'email'],
  // OAuth flow endpoints
  startRedirectPath: '/login/google',
  callbackUri: process.env.OAUTH_CALLBACK || 'http://localhost:3000/oauth2/callback',
  // Remove PKCE since we're having issues with it
  // pkce: 'S256', <- REMOVE THIS LINE
  generateStateFunction: (request) => {
    // Generate a secure random state
    const state = require('crypto').randomBytes(16).toString('hex');
    request.session.oauthState = state;
    return state;
  },
  checkStateFunction: (request, callback) => {
    const state = request.query.state;
    const savedState = request.session.oauthState;
    
    console.log('Checking state:', { 
      providedState: state, 
      savedState: savedState 
    });
    
    if (!savedState || state !== savedState) {
      callback(new Error('Invalid state parameter'));
      return;
    }
    callback();
  }
})

// Simplify the landing page UI
fastify.get('/', async (request, reply) => {
  const userEmail = request.cookies.userEmail
  let userInfo = null

  if (userEmail) {
    const tokenFile = path.join(DATA_DIR, `${userEmail}.json`)
    if (fs.existsSync(tokenFile)) {
      userInfo = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    }
  }

  reply.type('text/html')
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Gmail Connection</title>
      <style>
        :root {
          --primary: #333333;
          --primary-dark: #555555;
          --secondary: #2d3748;
          --text: #ffffff;
          --text-muted: #a0aec0;
          --bg-dark: #121212;
          --bg-card: #1e1e1e;
          --success: #48bb78;
          --danger: #f56565;
          --shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body { 
          font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; 
          max-width: 600px; 
          margin: 0 auto; 
          padding: 40px 20px; 
          background-color: var(--bg-dark);
          color: var(--text);
          line-height: 1.6;
          text-align: center;
        }
        
        .logo {
          font-size: 2.4em;
          font-weight: 700;
          color: var(--text);
          margin-bottom: 30px;
          letter-spacing: -0.5px;
        }
        
        .btn { 
          display: inline-block; 
          background: #007BFF; /* Blue button */
          color: white; 
          padding: 12px 28px;
          text-decoration: none; 
          border-radius: 6px; 
          margin: 15px 0;
          font-weight: 500;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5); /* Subtle shadow */
          transition: all 0.3s ease;
          border: none;
          cursor: pointer;
        }
        
        .btn:hover {
          background: #0056b3; /* Darker blue on hover */
          transform: translateY(-2px);
          box-shadow: 0 6px 10px rgba(0, 0, 0, 0.6); /* Slightly stronger shadow */
        }
        
        .btn-logout {
          background: var(--danger);
        }
        
        .btn-logout:hover {
          background: #e53e3e;
        }
        
        .card { 
          background: var(--bg-card); 
          padding: 30px; 
          border-radius: 12px; 
          box-shadow: var(--shadow);
          margin: 20px 0;
          border: 1px solid #333;
        }
        
        .status-badge {
          display: inline-block;
          background: var(--success);
          color: white;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 0.9em;
          margin: 15px 0;
          font-weight: 500;
        }
      </style>
    </head>
    <body>
      <div class="logo">Gmail Connection</div>
      
      ${userInfo ? `
        <div class="card">
          <div class="status-badge">&#10003; Connected</div>
          <p>Thank you! Your Gmail account has been successfully connected.</p>
          <p style="margin-top: 15px; color: var(--text-muted);">You may close this window.</p>
          
          <div style="margin-top: 30px;">
            <a href="/logout" class="btn btn-logout">Disconnect</a>
          </div>
        </div>
      ` : `
        <div class="card">
          <p>Click to connect your Gmail.</p> <!-- Updated text -->
          <a href="/login/google" class="btn">Connect Gmail</a>
        </div>
      `}
    </body>
    </html>
  `
})

// Callback route that Google will redirect to after authentication
fastify.get('/oauth2/callback', async function (request, reply) {
  try {
    const { token } = await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${token.access_token}`
      }
    });

    if (!userInfoResponse.ok) {
      throw new Error('Failed to get user info');
    }

    const userInfo = await userInfoResponse.json();
    const userEmail = userInfo.email;

    if (!userEmail) {
      throw new Error('No email found in user info');
    }

    const tokenFile = path.join(DATA_DIR, `${userEmail}.json`);
    const tokenData = {
      token,
      userInfo,
      created: new Date().toISOString()
    };

    fs.writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));

    reply.setCookie('userEmail', userEmail, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 // 30 days
    });

    // Redirect the client immediately after confirming the connection
    reply.redirect('/');

    // Start processing in the background, completely detached from the HTTP request
    setTimeout(() => {
      console.log(`Starting async email processing for ${userEmail}...`);
      emailProcessor.processEmailsToCSV(userEmail, token.access_token, 10)
        .then(result => {
          console.log(`Email processing completed for ${userEmail}:`, result);
        })
        .catch(error => {
          console.error(`Error processing emails for ${userEmail}:`, error);
        });
    }, 100); // Small delay to ensure response is sent first
    
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    reply.status(500).send('Authentication failed');
  }
})

// Route to fetch Gmail messages
fastify.get('/gmail-messages', async function (request, reply) {
  const userEmail = request.cookies.userEmail

  if (!userEmail) {
    return reply.redirect('/')
  }

  const tokenFile = path.join(DATA_DIR, `${userEmail}.json`)

  if (!fs.existsSync(tokenFile)) {
    return reply.redirect('/')
  }

  try {
    const userData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    let accessToken = userData.token.access_token

    const isTokenExpired = userData.token.expires_at && new Date(userData.token.expires_at) < new Date()

    if (isTokenExpired && userData.token.refresh_token) {
      const refreshResult = await this.googleOAuth2.getNewAccessTokenUsingRefreshToken(userData.token)
      userData.token = refreshResult.token
      accessToken = refreshResult.token.access_token
      fs.writeFileSync(tokenFile, JSON.stringify(userData, null, 2))
    }

    const response = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=10', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    })

    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.statusText}`)
    }

    const data = await response.json();
    if (!data.messages || !Array.isArray(data.messages)) {
      throw new Error('Invalid Gmail API response: Missing or malformed "messages" field');
    }

    const messagePromises = data.messages.map(msg => 
      fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }).then(res => res.json())
    )

    const messages = await Promise.all(messagePromises)

    reply.type('text/html')
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Your Messages - Gmail Access Portal</title>
        <style>
          :root {
            --primary: #333333;
            --primary-dark: #555555;
            --secondary: #2d3748;
            --text: #ffffff;
            --text-muted: #a0aec0;
            --bg-dark: #121212;
            --bg-card: #1e1e1e;
            --card-hover: #2a2a2a;
            --success: #48bb78;
            --danger: #f56565;
            --shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body { 
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; 
            max-width: 1000px; 
            margin: 0 auto; 
            padding: 40px 20px; 
            background-color: var(--bg-dark);
            color: var(--text);
            line-height: 1.6;
          }
          
          .header {
            text-align: center;
            margin-bottom: 40px;
          }
          
          .logo {
            font-size: 2.8em;
            font-weight: 700;
            color: var(--text);
            margin-bottom: 5px;
            letter-spacing: -0.5px;
          }
          
          h1 {
            color: white;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.2em;
            font-weight: 600;
          }
          
          .message { 
            background: var(--bg-card);
            border-radius: 10px; 
            padding: 24px; 
            margin-bottom: 20px;
            box-shadow: var(--shadow);
            transition: all 0.3s ease;
            border-left: 4px solid var(--primary);
          }
          
          .message:hover {
            transform: translateY(-3px);
            background: var(--card-hover);
            box-shadow: 0 8px 15px rgba(0, 0, 0, 0.6);
          }
          
          .subject { 
            font-weight: 600;
            font-size: 1.3em;
            color: white;
            margin-bottom: 12px;
          }
          
          .from { 
            color: var(--text-muted);
            margin-bottom: 12px;
            font-weight: 500;
          }
          
          .date {
            color: var(--text-muted);
            font-size: 0.9em;
            font-weight: 400;
          }
          
          .btn { 
            display: inline-block; 
            background: #007BFF; /* Blue button */
            color: white; 
            padding: 12px 28px;
            text-decoration: none; 
            border-radius: 6px; 
            margin: 15px 0;
            font-weight: 500;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5); /* Subtle shadow */
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
          }
          
          .btn:hover {
            background: #0056b3; /* Darker blue on hover */
            transform: translateY(-2px);
            box-shadow: 0 6px 10px rgba(0, 0, 0, 0.6); /* Slightly stronger shadow */
          }
          
          .email-count {
            text-align: center;
            margin-bottom: 30px;
            color: var(--text-muted);
            font-size: 1.1em;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">Gmail Access Portal</div>
        </div>
        <h1>Recent Messages</h1>
        <div class="email-count">Showing ${messages.length} most recent messages</div>
        <a href="/" class="btn">Back to Dashboard</a>
        <div style="margin-top: 30px;">
          ${messages.map(msg => {
            const headers = {}
            msg.payload.headers.forEach(header => {
              headers[header.name.toLowerCase()] = header.value
            })

            return `
              <div class="message">
                <div class="subject">${headers.subject || 'No Subject'}</div>
                <div class="from">${headers.from || 'Unknown Sender'}</div>
                <div class="date">
                  ${headers.date || 'Unknown Date'}
                </div>
              </div>
            `
          }).join('')}
        </div>
      </body>
      </html>
    `
  } catch (error) {
    request.log.error(error)
    reply.type('text/html')
    return reply.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - Gmail Access Portal</title>
        <style>
          :root {
            --primary: #333333;
            --primary-dark: #555555;
            --secondary: #2d3748;
            --text: #ffffff;
            --text-muted: #a0aec0;
            --bg-dark: #121212;
            --bg-card: #1e1e1e;
            --danger: #f56565;
            --shadow: 0 4px 6px rgba(0, 0, 0, 0.5);
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body { 
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; 
            max-width: 600px; 
            margin: 0 auto; 
            padding: 50px 20px; 
            text-align: center;
            background-color: var(--bg-dark);
            color: var(--text);
          }
          
          h1 { 
            color: var(--danger);
            font-size: 2em;
            margin-bottom: 25px;
          }
          
          .error-box {
            background: var(--bg-card);
            border-radius: 10px;
            padding: 30px;
            box-shadow: var(--shadow);
            margin: 30px 0;
            border-left: 4px solid var(--danger);
          }
          
          .btn { 
            display: inline-block; 
            background: #007BFF; /* Blue button */
            color: white; 
            padding: 12px 28px;
            text-decoration: none; 
            border-radius: 6px; 
            margin: 15px 0;
            font-weight: 500;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.5); /* Subtle shadow */
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
          }
          
          .btn:hover {
            background: #0056b3; /* Darker blue on hover */
            transform: translateY(-2px);
            box-shadow: 0 6px 10px rgba(0, 0, 0, 0.6); /* Slightly stronger shadow */
          }
          
          .logo {
            font-size: 2.2em;
            font-weight: 700;
            color: var(--text);
            margin-bottom: 30px;
            letter-spacing: -0.5px;
          }
        </style>
      </head>
      <body>
        <div class="logo">Gmail Access Portal</div>
        <h1>Gmail Authentication Failed</h1>
        <div class="error-box">
          <p>Error: ${error.message}</p>
        </div>
        <a href="/" class="btn">Return to Sign In</a>
      </body>
      </html>
    `)
  }
})

// Create a directory for storing CSV files
const CSV_DIR = path.join(__dirname, 'csv_exports')
if (!fs.existsSync(CSV_DIR)) {
  fs.mkdirSync(CSV_DIR, { recursive: true })
}

// Helper function to decode email body from base64
function decodeEmailBody(part) {
  if (!part) return '';
  
  if (part.body && part.body.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf-8');
  }
  
  if (part.parts) {
    // Try to find a text/plain part first
    const plainTextPart = part.parts.find(p => p.mimeType === 'text/plain');
    if (plainTextPart && plainTextPart.body && plainTextPart.body.data) {
      return Buffer.from(plainTextPart.body.data, 'base64').toString('utf-8');
    }
    
    // If no text/plain, try text/html
    const htmlPart = part.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart && htmlPart.body && htmlPart.body.data) {
      return Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
    }
    
    // Recursively check nested parts
    let body = '';
    for (const subPart of part.parts) {
      body += decodeEmailBody(subPart);
    }
    return body;
  }
  
  return '';
}

// Helper function to escape CSV fields
function escapeCSVField(field) {
  if (field === null || field === undefined) return '';
  
  const stringField = String(field);
  // If the field contains quotes, commas, or newlines, wrap in quotes and escape internal quotes
  if (stringField.includes('"') || stringField.includes(',') || stringField.includes('\n')) {
    return `"${stringField.replace(/"/g, '""')}"`;
  }
  return stringField;
}

// Function to process and save emails to CSV
async function processEmailsToCSV(userEmail, accessToken, maxResults = 10) {
  console.log(`Processing emails for ${userEmail}...`);
  
  try {
    // Get list of messages (now using maxResults=10 by default)
    const response = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    if (!data.messages || !Array.isArray(data.messages)) {
      throw new Error('Invalid Gmail API response: Missing or malformed "messages" field');
    }
    
    if (!data.messages || data.messages.length === 0) {
      console.log(`No messages found for ${userEmail}`);
      return { success: true, count: 0 };
    }
    
    console.log(`Found ${data.messages.length} messages for ${userEmail}`);
    
    // Fetch full message details
    const messagePromises = data.messages.map(msg => 
      fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      }).then(res => res.json())
    );
    
    const messages = await Promise.all(messagePromises);
    
    // Prepare CSV file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFilePath = path.join(CSV_DIR, `${userEmail.replace('@', '_at_')}_${timestamp}.csv`);
    const csvHeader = 'Message ID,Thread ID,Date,From,To,Subject,Body\n';
    
    // Write header
    fs.writeFileSync(csvFilePath, csvHeader, 'utf8');
    
    // Process each message and append to CSV
    let csvData = '';
    
    for (const msg of messages) {
      // Extract headers
      const headers = {};
      msg.payload.headers.forEach(header => {
        headers[header.name.toLowerCase()] = header.value;
      });
      
      // Extract body
      const body = decodeEmailBody(msg.payload);
      
      // Create CSV row
      const csvRow = [
        escapeCSVField(msg.id),
        escapeCSVField(msg.threadId),
        escapeCSVField(headers.date || ''),
        escapeCSVField(headers.from || ''),
        escapeCSVField(headers.to || ''),
        escapeCSVField(headers.subject || ''),
        escapeCSVField(body)
      ].join(',') + '\n';
      
      csvData += csvRow;
      
      // Write in chunks to avoid memory issues with large datasets
      if (csvData.length > 1000000) { // ~1MB chunks
        fs.appendFileSync(csvFilePath, csvData, 'utf8');
        csvData = '';
      }
    }
    
    // Write any remaining data
    if (csvData.length > 0) {
      fs.appendFileSync(csvFilePath, csvData, 'utf8');
    }
    
    console.log(`CSV file created at: ${csvFilePath}`);
    
    return { 
      success: true, 
      count: messages.length, 
      filePath: csvFilePath 
    };
  } catch (error) {
    console.error(`Error processing emails for ${userEmail}:`, error);
    return { success: false, error: error.message };
  }
}

// Make /api/extract-emails endpoint asynchronous
fastify.get('/api/extract-emails', async (request, reply) => {
  // Secure the API endpoint with API key
  const apiKey = request.headers['x-api-key'] || request.query.key;
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  
  // Get filter criteria from query parameter
  const filterCriteria = request.query.criteria;
  
  try {
    // Get all user token files
    if (!fs.existsSync(DATA_DIR)) {
      return reply.send({ status: 'error', message: 'No data directory found' });
    }
    
    const files = fs.readdirSync(DATA_DIR);
    const tokenFiles = files.filter(file => file.endsWith('.json'));
    
    if (tokenFiles.length === 0) {
      return reply.send({ status: 'success', message: 'No users found for processing' });
    }
    
    // Send immediate response that processing has started
    reply.send({
      status: 'processing',
      message: 'Email processing started asynchronously',
      userCount: tokenFiles.length,
      filterCriteria: filterCriteria || 'Client communications and interactions'
    });
    
    // Process each user's emails asynchronously (after response is sent)
    setTimeout(async () => {
      console.log(`Starting async batch processing for ${tokenFiles.length} users...`);
      
      for (const file of tokenFiles) {
        const userEmail = file.replace('.json', '');
        const tokenFile = path.join(DATA_DIR, file);
        
        try {
          const userData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
          let accessToken = userData.token.access_token;
          
          // Check if token is expired
          const isTokenExpired = userData.token.expires_at && new Date(userData.token.expires_at) < new Date();
          
          if (isTokenExpired && userData.token.refresh_token) {
            try {
              const refreshResult = await fastify.googleOAuth2.getNewAccessTokenUsingRefreshToken(userData.token);
              userData.token = refreshResult.token;
              accessToken = refreshResult.token.access_token;
              fs.writeFileSync(tokenFile, JSON.stringify(userData, null, 2));
            } catch (refreshError) {
              console.error(`Error refreshing token for ${userEmail}:`, refreshError);
              continue; // Skip this user
            }
          }
          
          // Process one user at a time to prevent OpenAI API rate limiting
          console.log(`Processing emails for ${userEmail}...`);
          try {
            const result = await emailProcessor.processEmailsToCSV(
              userEmail, 
              accessToken, 
              request.query.maxResults || 50,
              filterCriteria
            );
            console.log(`Completed processing for ${userEmail}:`, result);
          } catch (processError) {
            console.error(`Error processing emails for ${userEmail}:`, processError);
          }
        } catch (userError) {
          console.error(`Error processing user ${userEmail}:`, userError);
        }
      }
      
      console.log('Finished processing all users');
    }, 100);
    
  } catch (error) {
    console.error('Error starting email processing:', error);
    // The response was already sent, so no need to send an error response
  }
});

// Update individual user email extraction endpoint similarly
fastify.get('/api/extract-user-emails/:email', async (request, reply) => {
  const apiKey = request.headers['x-api-key'] || request.query.key;
  const expectedKey = process.env.API_KEY;
  
  if (!apiKey || apiKey !== expectedKey) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  
  // Get filter criteria from query parameter
  const filterCriteria = request.query.criteria;
  
  const userEmail = request.params.email;
  const tokenFile = path.join(DATA_DIR, `${userEmail}.json`);
  
  if (!fs.existsSync(tokenFile)) {
    return reply.status(404).send({ 
      status: 'error', 
      message: `User ${userEmail} not found` 
    });
  }
  
  try {
    const userData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    let accessToken = userData.token.access_token;
    
    // Check if token is expired
    const isTokenExpired = userData.token.expires_at && new Date(userData.token.expires_at) < new Date();
    
    if (isTokenExpired && userData.token.refresh_token) {
      const refreshResult = await fastify.googleOAuth2.getNewAccessTokenUsingRefreshToken(userData.token);
      userData.token = refreshResult.token;
      accessToken = refreshResult.token.access_token;
      fs.writeFileSync(tokenFile, JSON.stringify(userData, null, 2));
    }
    
    // Process the user's emails using the imported function
    const result = await emailProcessor.processEmailsToCSV(
      userEmail, 
      accessToken, 
      request.query.maxResults || 10, // Updated default to 50
      filterCriteria
    );
    
    return reply.send({
      status: 'success',
      message: `Email processing for ${userEmail} completed`,
      filterCriteria: filterCriteria || 'None',
      result
    });
  } catch (error) {
    return reply.status(500).send({
      status: 'error',
      message: `Failed to process emails for ${userEmail}`,
      error: error.message
    });
  }
});

// Logout route
fastify.get('/logout', async (request, reply) => {
  const userEmail = request.cookies.userEmail

  if (userEmail) {
    reply.clearCookie('userEmail', { path: '/' })
  }

  return reply.redirect('/')
})

// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' })
    console.log('Server running at http://localhost:3000')
    console.log('Token storage directory:', DATA_DIR)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

// Add this after creating the fastify server
fastify.server.timeout = 0; // Disable socket timeout
fastify.server.keepAliveTimeout = 120000; // 2 minutes

start()
