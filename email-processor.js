const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { convert } = require('html-to-text');

// Directory for CSV exports
const CSV_DIR = path.join(__dirname, 'csv_exports');
if (!fs.existsSync(CSV_DIR)) {
  fs.mkdirSync(CSV_DIR, { recursive: true });
}

/* ----- Modular Cleaning Functions ----- */

/**
 * Remove <script>, <style>, and <noscript> blocks from HTML.
 * @param {string} html - The HTML content to clean.
 * @returns {string} HTML with scripts and styles removed.
 */
function removeScriptAndStyle(html) {
  return html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Remove common footer or signature elements from HTML using Cheerio.
 * @param {CheerioAPI} $ - Cheerio instance loaded with HTML.
 */
function removeBoilerplate($) {
  // Remove elements with common footer-related classes
  $('.footer, .email-footer, .signature, .legal, .disclaimer, .footer-container, .email-bottom, .message-signature, .legal-notice').remove();

  // Remove elements containing footer keywords
  $('*').each((i, el) => {
    const text = $(el).text().toLowerCase();
    if (
      text.includes('unsubscribe') ||
      text.includes('privacy policy') ||
      text.includes('terms and conditions') ||
      text.includes('you received this email because') ||
      text.includes('view in browser') ||
      text.includes('sent from my') ||
      text.includes('this email was sent by') ||
      text.includes('copyright') ||
      text.includes('all rights reserved')
    ) {
      $(el).remove();
    }
  });

  // Remove parent elements of footer links
  $('a[href*="unsubscribe"], a[href*="privacy"], a[href*="terms"]').parent().remove();

  // Remove content after horizontal rules (common signature separator)
  $('hr').nextAll().remove();
  $('hr').remove();
}

/**
 * Convert cleaned HTML to plain text using html-to-text.
 * @param {string} html - The HTML content to convert.
 * @returns {string} Plain text representation of the HTML.
 */
function convertHTMLToText(html) {
  return convert(html, {
    wordwrap: false,
    ignoreImage: true,
    preserveNewlines: true,
  });
}

/**
 * Filter out boilerplate lines from text, such as footers or signatures.
 * @param {string} text - The text to filter.
 * @returns {string} Text with boilerplate lines removed.
 */
function filterBoilerplateLines(text) {
  const footerKeywords = [
    'unsubscribe', 'privacy policy', 'terms and conditions',
    'view in browser', 'sent from my', 'this email was sent by', 'copyright',
    'all rights reserved'
  ];
  
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length < 5) return false; // Skip very short lines
      // Skip lines with footer keywords only
      const lowerLine = line.toLowerCase();
      if (footerKeywords.some(keyword => lowerLine.includes(keyword))) {
        // Only filter if these are footer-like lines (short and only contain boilerplate)
        // Preserve lines that have these keywords but are part of the main content
        return line.length > 100 || !(/^[^a-zA-Z]*(\w+\s+){0,4}(unsubscribe|privacy|copyright)/).test(lowerLine);
      }
      // KEEP email addresses, phone numbers, and URLs - removing these filters
      return true;
    })
    .join('\n');
}

/**
 * Normalize whitespace in text, preserving newlines.
 * @param {string} text - The text to normalize.
 * @returns {string} Text with normalized whitespace.
 */
function normalizeWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
}

/**
 * Decode common HTML entities in text.
 * @param {string} text - The text containing HTML entities.
 * @returns {string} Text with entities decoded.
 */
function decodeHTMLEntities(text) {
  return text
    .replace(/ /gi, ' ')
    .replace(/&/gi, '&')
    .replace(/"/gi, '"')
    .replace(/</gi, '<')
    .replace(/>/gi, '>');
}

/**
 * Clean HTML email content by removing unwanted elements and converting to text.
 * @param {string} html - The HTML content to clean.
 * @returns {string} Cleaned plain text.
 */
function enhancedCleanEmailContent(html) {
  if (!html) return '';

  // Remove scripts and styles
  let cleanedHtml = removeScriptAndStyle(html);

  // Load into Cheerio for DOM manipulation
  const $ = cheerio.load(cleanedHtml);

  // Remove boilerplate content
  removeBoilerplate($);

  // Get the cleaned HTML
  cleanedHtml = $.html();

  // Convert to plain text
  let text = convertHTMLToText(cleanedHtml);

  // Decode HTML entities
  text = decodeHTMLEntities(text);

  // Filter out boilerplate lines
  text = filterBoilerplateLines(text);

  // Remove only tracking URLs, not all URLs
  text = text.replace(/https?:\/\/[^\s]+?(?:\?utm_[^\s]+|click[^\s]+|link\.[^\s]+)/g, '');
  
  // Keep most URLs, only remove tracking-specific ones
  text = text.replace(/https?:\/\/[^\/\s]+\/(track|click|open|view)[^\s]*/g, '');
  text = text.replace(/https?:\/\/[^\s]+\/(e|t)\/[a-zA-Z0-9]{5,}[^\s]*/g, '');

  // Remove bracket formatting and invisible characters
  text = text.replace(/\[\s*\[\s*\[/g, '');
  text = text.replace(/\]\s*\]\s*\]/g, '');
  text = text.replace(/\u200c|\u200b|\u200d|\u200e|\u200f|\u2060|\ufeff/g, '');

  // Normalize whitespace
  text = normalizeWhitespace(text);

  // Additional whitespace cleanup
  text = text.replace(/[\u200B-\u200D\u2060\uFEFF\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+/g, '');
  text = text.replace(/\n{3,}/g, '\n\n'); // Replace 3+ consecutive newlines with just 2

  // Detect duplicated content - but be more careful with this
  const halfLength = Math.floor(text.length / 2);
  if (halfLength > 100) {
    const firstHalf = text.substring(0, halfLength);
    const secondHalf = text.substring(halfLength);
    // Only consider it duplicated if a significant chunk is repeated
    if (secondHalf.includes(firstHalf.substring(0, 150))) {
      text = firstHalf;
    }
  }


  // Warn if text is too short (possible overcleaning)
  if (text.length < 20) {
    console.warn('Warning: Cleaned text is very short. Review original HTML.');
  }

  return text;
}

/**
 * Clean plain text email content by removing signatures and unwanted lines.
 * @param {string} text - The plain text to clean.
 * @returns {string} Cleaned plain text.
 */
function cleanPlainText(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let signatureStart = -1;

  // Detect signature start
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (
      trimmed.startsWith('--') ||
      /^[\s]*(Best regards|Sincerely|Cheers|Thanks),?[\s]*$/i.test(trimmed)
    ) {
      signatureStart = i;
      break;
    }
  }
  if (signatureStart !== -1) {
    lines.splice(signatureStart);
  }

  // Keep all content lines including URLs, emails, and phone numbers
  // Just filter out empty lines
  const cleanedLines = lines.filter(line => line.trim().length > 0);

  return normalizeWhitespace(cleanedLines.join('\n'));
}

/* ----- Email Decoding and CSV Processing ----- */

/**
 * Decode the email body from a Gmail payload, preferring plain text.
 * @param {object} part - The payload part to decode.
 * @returns {string} Cleaned email body text.
 */
function decodeEmailBody(part) {
  if (!part) return '';

  // Handle plain text
  if (part.mimeType === 'text/plain' && part.body && part.body.data) {
    const plain = Buffer.from(part.body.data, 'base64').toString('utf-8');
    return cleanPlainText(plain);
  }

  // Handle HTML
  if (part.mimeType === 'text/html' && part.body && part.body.data) {
    const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
    return enhancedCleanEmailContent(html);
  }

  // Handle multipart/alternative: prefer plain text over HTML
  if (part.mimeType === 'multipart/alternative' && part.parts) {
    const plainPart = part.parts.find(p => p.mimeType === 'text/plain');
    if (plainPart) return decodeEmailBody(plainPart);
    const htmlPart = part.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart) return decodeEmailBody(htmlPart);
    return part.parts.map(p => decodeEmailBody(p)).join('\n');
  }

  // Handle other multipart types (e.g., with attachments)
  if (part.parts) {
    return part.parts
      .map(subPart => decodeEmailBody(subPart))
      .filter(text => text && text.trim().length > 0)
      .join('\n');
  }

  return '';
}

/**
 * Escape CSV fields to handle commas, quotes, and newlines.
 * @param {any} field - The field to escape.
 * @returns {string} Escaped CSV field.
 */
function escapeCSVField(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Organize emails by thread, sorting them chronologically.
 * @param {Array} emails - Array of processed email objects.
 * @returns {Object} Object with threadIds as keys and arrays of sorted emails as values.
 */
function organizeEmailsByThread(emails) {
  const threads = {};

  emails.forEach(email => {
    if (!threads[email.threadId]) {
      threads[email.threadId] = [];
    }
    threads[email.threadId].push(email);
  });

  // Sort emails within each thread by date (oldest first)
  Object.values(threads).forEach(threadEmails => {
    threadEmails.sort((a, b) => new Date(a.date) - new Date(b.date));
  });

  return threads;
}

/**
 * Fetch complete email threads from Gmail and process them.
 * @param {string} userEmail - The user's email address.
 * @param {string} accessToken - OAuth token for Gmail API.
 * @param {number} [maxResults=50] - Max number of threads to fetch.
 * @param {string[]} [labelIds=['SENT']] - Gmail labels to query.
 * @returns {Promise<object>} Result of the processing.
 */
async function processThreadsToCSV(userEmail, accessToken, maxResults = 50, labelIds = ['SENT']) {
  // Convert labelIds to array if it's a string
  if (!Array.isArray(labelIds)) {
    labelIds = [labelIds];
  }

  console.log(`Processing email threads for ${userEmail} from labels: ${labelIds.join(', ')}`);

  try {
    // 1. Fetch the list of threads
    const labelQuery = labelIds.map(label => `labelIds=${encodeURIComponent(label)}`).join('&');
    const threadsResponse = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/threads?maxResults=${maxResults}&${labelQuery}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!threadsResponse.ok) {
      throw new Error(`Gmail API error: ${threadsResponse.statusText}`);
    }

    const threadsData = await threadsResponse.json();
    if (!threadsData.threads || threadsData.threads.length === 0) {
      console.log(`No threads found for ${userEmail}`);
      return { success: true, count: 0 };
    }

    console.log(`Found ${threadsData.threads.length} threads for ${userEmail}`);

    // 2. Fetch all messages in each thread
    const threadPromises = threadsData.threads.map(thread =>
      fetch(
        `https://www.googleapis.com/gmail/v1/users/me/threads/${thread.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ).then(res => res.json())
    );
    const completeThreads = await Promise.all(threadPromises);

    // 3. Process each thread's messages
    const processedEmails = [];
    let totalMessageCount = 0;

    for (const thread of completeThreads) {
      if (thread.messages && Array.isArray(thread.messages)) {
        totalMessageCount += thread.messages.length;
        for (const msg of thread.messages) {
          const headers = {};
          if (msg?.payload?.headers) {
            msg.payload.headers.forEach(header => {
              headers[header.name.toLowerCase()] = header.value;
            });
          }
          const body = msg?.payload ? decodeEmailBody(msg.payload) : '';
          processedEmails.push({
            id: msg?.id || 'unknown',
            threadId: thread.id || 'unknown',
            date: headers.date || '',
            from: headers.from || '',
            to: headers.to || '',
            subject: headers.subject || '',
            body: body
          });
        }
      }
    }

    // 4. Organize emails by thread and write to CSV
    const threadedEmails = organizeEmailsByThread(processedEmails);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFilePath = path.join(CSV_DIR, `${userEmail.replace('@', '_at_')}_threads_${timestamp}.csv`);
    const csvHeader = 'Thread ID,Thread Position,Message ID,Date,From,To,Subject,Body\n';
    fs.writeFileSync(csvFilePath, csvHeader, 'utf8');

    let csvData = '';
    for (const [threadId, emails] of Object.entries(threadedEmails)) {
      emails.forEach((email, index) => {
        const csvRow = [
          escapeCSVField(threadId),
          escapeCSVField(index + 1),
          escapeCSVField(email.id),
          escapeCSVField(email.date),
          escapeCSVField(email.from),
          escapeCSVField(email.to),
          escapeCSVField(email.subject),
          escapeCSVField(email.body)
        ].join(',') + '\n';
        csvData += csvRow;

        if (csvData.length > 1000000) {
          fs.appendFileSync(csvFilePath, csvData, 'utf8');
          csvData = '';
        }
      });
    }
    if (csvData.length > 0) {
      fs.appendFileSync(csvFilePath, csvData, 'utf8');
    }

    console.log(`Thread-based CSV created at: ${csvFilePath}`);
    return {
      success: true,
      threadCount: Object.keys(threadedEmails).length,
      messageCount: totalMessageCount,
      csvFilePath
    };
  } catch (error) {
    console.error(`Error processing email threads for ${userEmail}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch emails from Gmail, clean their content, and write to a CSV file.
 * @param {string} userEmail - The user's email address.
 * @param {string} accessToken - OAuth token for Gmail API.
 * @param {number} [maxResults=50] - Max number of messages to fetch.
 * @param {string[]} [labelIds=['SENT']] - Gmail labels to query.
 * @returns {Promise<object>} Result of the processing.
 */
async function processEmailsToCSV(userEmail, accessToken, maxResults = 50, labelIds = ['SENT']) {
  console.log(`Processing emails for ${userEmail} from labels: ${labelIds.join(', ')}`);

  try {
    // Fetch list of messages
    const labelQuery = labelIds.map(label => `labelIds=${encodeURIComponent(label)}`).join('&');
    const listResponse = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&${labelQuery}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!listResponse.ok) {
      throw new Error(`Gmail API error: ${listResponse.statusText}`);
    }

    const listData = await listResponse.json();
    if (!listData.messages || listData.messages.length === 0) {
      console.log(`No messages found for ${userEmail}`);
      return { success: true, count: 0 };
    }
    console.log(`Found ${listData.messages.length} messages for ${userEmail}`);

    // Fetch full message details
    const messagePromises = listData.messages.map(msg =>
      fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ).then(res => res.json())
    );
    const messages = await Promise.all(messagePromises);

    // Process each message
    const processedEmails = messages.map(msg => {
      const headers = {};
      if (msg?.payload?.headers) {
        msg.payload.headers.forEach(header => {
          headers[header.name.toLowerCase()] = header.value;
        });
      } else {
        console.warn(`Warning: Message ${msg?.id || 'unknown'} has an unexpected structure.`);
      }
      const body = msg?.payload ? decodeEmailBody(msg.payload) : '';
      return {
        id: msg?.id || 'unknown',
        threadId: msg?.threadId || 'unknown',
        date: headers.date || '',
        from: headers.from || '',
        to: headers.to || '',
        subject: headers.subject || '',
        body: body
      };
    });

    // Write to CSV
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFilePath = path.join(CSV_DIR, `${userEmail.replace('@', '_at_')}_${timestamp}.csv`);
    const csvHeader = 'Message ID,Thread ID,Date,From,To,Subject,Body\n';
    fs.writeFileSync(csvFilePath, csvHeader, 'utf8');

    let csvData = '';
    for (const email of processedEmails) {
      const csvRow = [
        escapeCSVField(email.id),
        escapeCSVField(email.threadId),
        escapeCSVField(email.date),
        escapeCSVField(email.from),
        escapeCSVField(email.to),
        escapeCSVField(email.subject),
        escapeCSVField(email.body)
      ].join(',') + '\n';
      csvData += csvRow;
      if (csvData.length > 1000000) { // Write in chunks
        fs.appendFileSync(csvFilePath, csvData, 'utf8');
        csvData = '';
      }
    }
    if (csvData.length > 0) {
      fs.appendFileSync(csvFilePath, csvData, 'utf8');
    }
    console.log(`CSV file created at: ${csvFilePath}`);
    return {
      success: true,
      count: processedEmails.length,
      filePath: csvFilePath,
      totalProcessed: processedEmails.length
    };
  } catch (error) {
    console.error(`Error processing emails for ${userEmail}:`, error);
    return { success: false, error: error.message };
  }
}

// Export functions for use in other modules
module.exports = {
  processEmailsToCSV,
  processThreadsToCSV,
  decodeEmailBody,
  escapeCSVField,
  enhancedCleanEmailContent
};
