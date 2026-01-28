#!/usr/bin/env node

/**
 * Social Screenshot Tool
 * Generate clean screenshot cards from social media post URLs
 *
 * Usage: node screenshot.js <url>
 * Example: node screenshot.js "https://x.com/aaronp613/status/2011100291228487867"
 */

const { chromium } = require('playwright');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const CARD_WIDTH = 550; // Base width for cards
const DEFAULT_PARALLEL = 3; // Number of concurrent downloads

// Global browser instance for reuse
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const result = {
    urls: [],
    file: null,
    output: DEFAULT_SCREENSHOTS_DIR,
    parallel: DEFAULT_PARALLEL,
    thread: false, // Capture threads/replies as combined cards
    bento: false, // Apple bento-style cards for Keynote slides
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--file' && args[i + 1]) {
      result.file = args[i + 1];
      i++;
    } else if (arg === '--output' && args[i + 1]) {
      result.output = path.resolve(args[i + 1]);
      i++;
    } else if (arg === '--thread') {
      result.thread = true;
    } else if (arg === '--bento') {
      result.bento = true;
    } else if (arg === '--parallel' && args[i + 1]) {
      result.parallel = parseInt(args[i + 1]) || DEFAULT_PARALLEL;
      i++;
    } else if (arg.startsWith('http')) {
      result.urls.push(arg);
    }
  }

  return result;
}

/**
 * Process URLs in parallel with concurrency limit
 */
async function processInParallel(urls, outputDir, concurrency, options = {}) {
  const results = [];
  const total = urls.length;
  let completed = 0;

  // Process in batches
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchPromises = batch.map((url, batchIndex) => {
      const index = i + batchIndex;
      return processUrl(url, index, total, outputDir, options);
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    completed += batchResults.length;
  }

  return results;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fetch HTML content from a URL
 */
async function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    };

    protocol.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch JSON from a URL
 */
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    };

    protocol.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Convert image URL to base64 data URI
 */
async function imageToBase64(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve(null);
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return imageToBase64(res.headers.location).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/jpeg';
        const base64 = buffer.toString('base64');
        resolve(`data:${contentType};base64,${base64}`);
      });
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

/**
 * Download and save an image file
 */
async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve(null);
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, filepath).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }

      const fileStream = fs.createWriteStream(filepath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filepath);
      });
      fileStream.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

/**
 * Get file extension from URL or content type
 */
function getImageExtension(url) {
  // Check URL for extension
  const urlMatch = url.match(/\.(jpg|jpeg|png|gif|webp)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();

  // Check format parameter (Twitter style)
  const formatMatch = url.match(/format=(jpg|jpeg|png|gif|webp)/i);
  if (formatMatch) return formatMatch[1].toLowerCase();

  return 'jpg'; // default
}

/**
 * Format numbers (e.g., 1234 -> 1.2K)
 */
function formatNumber(num) {
  if (!num) return '0';
  const n = parseInt(num);
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

/**
 * Format relative time
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Generate a safe filename from URL
 */
function generateFilename(url, platform) {
  const timestamp = Date.now();
  const urlHash = url.split('/').pop().replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  return `${platform}-${urlHash}-${timestamp}.png`;
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace('/', '').split(/[?#]/)[0];
    }
    const vParam = parsed.searchParams.get('v');
    if (vParam) return vParam;
    const shortsMatch = parsed.pathname.match(/\/shorts\/([^\/]+)/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = parsed.pathname.match(/\/embed\/([^\/]+)/);
    if (embedMatch) return embedMatch[1];
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Build metadata payload (without base64 fields)
 */
function buildMetadataPayload(data, url, cardFilename, downloadedImages) {
  const payload = {
    platform: data.platform,
    url: data.url || url,
    card: path.basename(cardFilename),
  };

  if (data.platform === 'twitter-thread' && data.tweets) {
    payload.tweets = data.tweets.map(tweet => ({
      author: tweet.author ? {
        name: tweet.author.name,
        handle: tweet.author.handle,
        avatarUrl: tweet.author.avatarUrl,
        verified: tweet.author.verified,
      } : undefined,
      content: tweet.content,
      timestamp: tweet.timestamp,
      originalImageUrls: tweet.originalImageUrls || [],
      isMainTweet: tweet.isMainTweet || false,
    }));
    payload.media = {
      originalUrls: data.tweets.flatMap(tweet => tweet.originalImageUrls || []),
      downloaded: downloadedImages,
    };
    return payload;
  }

  if (data.author) {
    payload.author = {
      name: data.author.name,
      handle: data.author.handle,
      title: data.author.title,
      avatarUrl: data.author.avatarUrl,
      verified: data.author.verified,
    };
  }

  if (data.content) payload.content = data.content;
  if (data.title) payload.title = data.title;
  if (data.description) payload.description = data.description;
  if (data.timestamp) payload.timestamp = data.timestamp;
  if (data.metrics) payload.metrics = data.metrics;
  if (data.siteName) payload.siteName = data.siteName;
  if (data.instance) payload.instance = data.instance;
  if (data.postNumber) payload.postNumber = data.postNumber;
  if (data.reactions) payload.reactions = data.reactions;
  if (data.video) payload.video = data.video;
  if (data.faviconUrl) payload.faviconUrl = data.faviconUrl;
  if (data.imageUrl) payload.imageUrl = data.imageUrl;
  if (data.thumbnailUrl) payload.thumbnailUrl = data.thumbnailUrl;

  payload.media = {
    originalUrls: data.originalImageUrls || [],
    downloaded: downloadedImages,
  };

  return payload;
}

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

function detectPlatform(url) {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('x.com') || urlLower.includes('twitter.com')) {
    return 'twitter';
  }
  if (urlLower.includes('forums.macrumors.com')) {
    return 'macrumors';
  }
  if (urlLower.includes('threads.net')) {
    return 'threads';
  }
  if (urlLower.includes('bsky.app')) {
    return 'bluesky';
  }
  if (urlLower.includes('mastodon.social') || urlLower.includes('zeppelin.flights') || urlLower.includes('@')) {
    // Check for Mastodon-style URLs
    if (urlLower.match(/\/@[\w]+\/\d+/)) {
      return 'mastodon';
    }
  }
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
    return 'youtube';
  }
  if (urlLower.includes('tiktok.com')) {
    return 'tiktok';
  }
  if (urlLower.includes('cultofmac.com') || urlLower.includes('newsletters.')) {
    return 'article';
  }

  return 'unknown';
}

// ============================================================================
// PLATFORM SCRAPERS
// ============================================================================

/**
 * Twitter/X Scraper - Uses browser to load embed and extract data
 */
async function scrapeTwitter(url) {
  // Extract tweet ID from URL
  const match = url.match(/status\/(\d+)/);
  if (!match) throw new Error('Invalid Twitter URL');

  const tweetId = match[1];

  // Use browser to load the Twitter embed page
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Load the embed version of the tweet
    const embedUrl = `https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&theme=dark`;
    await page.goto(embedUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for content to load
    await page.waitForSelector('[data-testid="tweetText"], .Tweet-text, article', { timeout: 10000 }).catch(() => {});

    // Wait a bit more for images
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract data from the embed page
    const data = await page.evaluate(() => {
      // Try to find tweet content
      const tweetText = document.querySelector('[data-testid="tweetText"]')?.innerText ||
                       document.querySelector('.Tweet-text')?.innerText ||
                       document.querySelector('[lang]')?.innerText || '';

      // Find author info
      const authorName = document.querySelector('[data-testid="User-Name"] a, .TweetAuthor-name')?.innerText?.split('\n')[0] || 'Unknown';
      const authorHandle = document.querySelector('[data-testid="User-Name"] a[href*="/"], .TweetAuthor-screenName')?.innerText?.replace('@', '') ||
                          document.querySelector('a[href*="twitter.com/"]')?.href?.match(/twitter\.com\/(\w+)/)?.[1] || 'unknown';

      // Find avatar
      const avatar = document.querySelector('img[src*="profile_images"]')?.src || '';

      // Find images
      const images = [];
      document.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
        if (img.src) images.push(img.src);
      });

      // Find metrics (these may not be available in embed)
      const metricsText = document.body.innerText;
      const likesMatch = metricsText.match(/(\d+(?:,\d+)*)\s*likes?/i);
      const retweetsMatch = metricsText.match(/(\d+(?:,\d+)*)\s*retweets?/i);

      // Find timestamp
      const timeEl = document.querySelector('time');
      const timestamp = timeEl?.getAttribute('datetime') || timeEl?.innerText || '';

      return {
        text: tweetText,
        authorName,
        authorHandle,
        avatar,
        images,
        timestamp,
        likes: likesMatch ? likesMatch[1].replace(/,/g, '') : '0',
        retweets: retweetsMatch ? retweetsMatch[1].replace(/,/g, '') : '0',
      };
    });

    await context.close();

    // Convert images to base64 for the card
    const avatarUrl = data.avatar;
    const avatarBase64 = await imageToBase64(avatarUrl);
    const imagesBase64 = [];
    for (const imgUrl of data.images.slice(0, 4)) {
      const base64 = await imageToBase64(imgUrl);
      if (base64) imagesBase64.push(base64);
    }

    // Upgrade image URLs to full resolution
    const originalImageUrls = data.images.map(url => {
      // Twitter image URLs can be upgraded to full resolution
      // e.g., add ?format=jpg&name=4096x4096
      if (url.includes('pbs.twimg.com/media')) {
        const baseUrl = url.split('?')[0];
        return `${baseUrl}?format=jpg&name=4096x4096`;
      }
      return url;
    });

    return {
      platform: 'twitter',
      author: {
        name: data.authorName,
        handle: data.authorHandle,
        avatar: avatarBase64,
        avatarUrl: avatarUrl,
        verified: false, // Can't easily detect from embed
      },
      content: data.text,
      images: imagesBase64,
      originalImageUrls: originalImageUrls, // Full resolution URLs for download
      timestamp: data.timestamp,
      metrics: {
        replies: 0,
        retweets: parseInt(data.retweets) || 0,
        likes: parseInt(data.likes) || 0,
        views: null,
      },
      url: url,
    };
  } catch (e) {
    await context.close();
    throw new Error(`Could not fetch tweet: ${e.message}`);
  }
}

/**
 * Twitter Thread Scraper - Fetches full conversation context
 * Returns an array of tweets: [parent tweets..., main tweet, replies...]
 */
async function scrapeTwitterThread(url) {
  const match = url.match(/status\/(\d+)/);
  if (!match) throw new Error('Invalid Twitter URL');

  const tweetId = match[1];

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Load the conversation view which shows thread context
    const embedUrl = `https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&theme=dark&conversation=all`;
    await page.goto(embedUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for content
    await page.waitForSelector('article, [data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract all tweets in the conversation
    const tweets = await page.evaluate(() => {
      const results = [];

      // Find all tweet containers
      const tweetElements = document.querySelectorAll('article, [data-tweet-id], .timeline-Tweet');

      tweetElements.forEach((tweetEl, index) => {
        const text = tweetEl.querySelector('[data-testid="tweetText"], .Tweet-text, [lang]')?.innerText || '';
        const authorName = tweetEl.querySelector('[data-testid="User-Name"] a, .TweetAuthor-name, a[role="link"]')?.innerText?.split('\n')[0] || 'Unknown';
        const authorHandle = tweetEl.querySelector('a[href*="/"]')?.href?.match(/(?:twitter|x)\.com\/(\w+)/)?.[1] || 'unknown';
        const avatar = tweetEl.querySelector('img[src*="profile_images"]')?.src || '';
        const timestamp = tweetEl.querySelector('time')?.getAttribute('datetime') || '';

        // Find images in this tweet
        const images = [];
        tweetEl.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
          if (img.src) images.push(img.src);
        });

        if (text || images.length > 0) {
          results.push({
            text,
            authorName,
            authorHandle,
            avatar,
            images,
            timestamp,
            isMainTweet: index === 0 // First one is usually the main tweet
          });
        }
      });

      return results;
    });

    await context.close();

    if (tweets.length === 0) {
      throw new Error('No tweets found in thread');
    }

    // Convert to our format with base64 images
    const formattedTweets = [];
    for (const tweet of tweets) {
      const avatarBase64 = await imageToBase64(tweet.avatar);
      const imagesBase64 = [];
      const originalImageUrls = [];

      for (const imgUrl of tweet.images.slice(0, 4)) {
        const base64 = await imageToBase64(imgUrl);
        if (base64) imagesBase64.push(base64);

        // Upgrade to full resolution
        if (imgUrl.includes('pbs.twimg.com/media')) {
          const baseUrl = imgUrl.split('?')[0];
          originalImageUrls.push(`${baseUrl}?format=jpg&name=4096x4096`);
        } else {
          originalImageUrls.push(imgUrl);
        }
      }

      formattedTweets.push({
        platform: 'twitter',
        author: {
          name: tweet.authorName,
          handle: tweet.authorHandle,
          avatar: avatarBase64,
          avatarUrl: tweet.avatar,
          verified: false,
        },
        content: tweet.text,
        images: imagesBase64,
        originalImageUrls,
        timestamp: tweet.timestamp,
        isMainTweet: tweet.isMainTweet,
      });
    }

    return {
      platform: 'twitter-thread',
      tweets: formattedTweets,
      url: url,
    };

  } catch (e) {
    await context.close();
    throw new Error(`Could not fetch thread: ${e.message}`);
  }
}

/**
 * MacRumors Forum Scraper
 */
async function scrapeMacrumors(url) {
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  // Find the specific post
  let postId = null;
  const postMatch = url.match(/post-(\d+)|#post-(\d+)|post=(\d+)/);
  if (postMatch) {
    postId = postMatch[1] || postMatch[2] || postMatch[3];
  }

  // Select the post element
  let postEl;
  if (postId) {
    postEl = $(`#post-${postId}, [data-content="post-${postId}"]`).first();
  }
  if (!postEl || postEl.length === 0) {
    postEl = $('.message-body').first().closest('.message');
  }

  // Extract data
  const authorEl = postEl.find('.message-userDetails');
  const contentEl = postEl.find('.message-body .bbWrapper');

  const authorName = postEl.find('.message-name').text().trim() ||
                     authorEl.find('.username').text().trim() || 'Unknown';
  const authorTitle = postEl.find('.userTitle').text().trim() || 'member';
  const postNumber = postEl.find('.message-attribution-opposite').text().trim().replace('#', '') || '';
  const timestamp = postEl.find('.message-attribution time').attr('datetime') ||
                    postEl.find('time').attr('datetime') || '';

  // Get avatar
  const avatarUrlRaw = postEl.find('.message-avatar img').attr('src') || '';
  const avatarUrl = avatarUrlRaw.startsWith('//') ? 'https:' + avatarUrlRaw : avatarUrlRaw;
  const avatarBase64 = await imageToBase64(avatarUrl);

  // Get post content (text only, clean up)
  let content = contentEl.clone();
  content.find('blockquote, .bbCodeBlock').remove(); // Remove quotes
  const text = content.text().trim().slice(0, 500);

  // Get any images in the post
  const images = [];
  contentEl.find('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src && !src.includes('smilies') && !src.includes('emoji')) {
      images.push(src.startsWith('//') ? 'https:' + src : src);
    }
  });

  const imagesBase64 = [];
  for (const imgUrl of images.slice(0, 4)) { // Max 4 images
    const base64 = await imageToBase64(imgUrl);
    if (base64) imagesBase64.push(base64);
  }

  // Get reactions/likes
  const reactions = postEl.find('.reactionsBar-link').text().trim();

  return {
    platform: 'macrumors',
    author: {
      name: authorName,
      title: authorTitle,
      avatar: avatarBase64,
      avatarUrl: avatarUrl,
    },
    content: text,
    images: imagesBase64,
    originalImageUrls: images, // Original URLs for download
    postNumber: postNumber,
    timestamp: timestamp,
    reactions: reactions,
    url: url,
  };
}

/**
 * Bluesky Scraper - Uses public API
 */
async function scrapeBluesky(url) {
  // Extract handle and post ID from URL
  // Format: https://bsky.app/profile/handle/post/postid
  const match = url.match(/profile\/([^\/]+)\/post\/([^\/\?]+)/);
  if (!match) throw new Error('Invalid Bluesky URL');

  const handle = match[1];
  const postId = match[2];

  // Resolve the handle to get the DID
  const resolveUrl = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`;

  try {
    // For bridged accounts, we need to handle them differently
    let did;
    if (handle.includes('.ap.brid.gy')) {
      // This is a bridged Mastodon account - try to get the post anyway
      const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${postId}&depth=0`;
      try {
        const threadData = await fetchJSON(apiUrl);
        const post = threadData.thread?.post;
        if (post) {
          return await formatBlueskyPost(post, url);
        }
      } catch (e) {
        // Fall through to other methods
      }
    }

    const resolveData = await fetchJSON(resolveUrl);
    did = resolveData.did;

    // Fetch the post
    const postUri = `at://${did}/app.bsky.feed.post/${postId}`;
    const threadUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=0`;
    const threadData = await fetchJSON(threadUrl);

    const post = threadData.thread?.post;
    if (!post) throw new Error('Post not found');

    return await formatBlueskyPost(post, url);
  } catch (e) {
    throw new Error(`Could not fetch Bluesky post: ${e.message}`);
  }
}

async function formatBlueskyPost(post, url) {
  // Get avatar
  const avatarUrl = post.author?.avatar || '';
  const avatarBase64 = await imageToBase64(avatarUrl);

  // Get embedded images
  const images = [];
  if (post.embed?.images) {
    for (const img of post.embed.images) {
      images.push(img.fullsize || img.thumb);
    }
  }
  // Also check for external embeds with thumbnails
  if (post.embed?.external?.thumb) {
    images.push(post.embed.external.thumb);
  }

  const imagesBase64 = [];
  for (const imgUrl of images) {
    const base64 = await imageToBase64(imgUrl);
    if (base64) imagesBase64.push(base64);
  }

  return {
    platform: 'bluesky',
    author: {
      name: post.author?.displayName || post.author?.handle || 'Unknown',
      handle: post.author?.handle || 'unknown',
      avatar: avatarBase64,
      avatarUrl: avatarUrl,
    },
    content: post.record?.text || '',
    images: imagesBase64,
    originalImageUrls: images, // Original URLs for download
    timestamp: post.record?.createdAt || post.indexedAt,
    metrics: {
      replies: post.replyCount || 0,
      reposts: post.repostCount || 0,
      likes: post.likeCount || 0,
    },
    url: url,
  };
}

/**
 * Mastodon Scraper
 */
async function scrapeMastodon(url) {
  // Parse the URL to get instance and post ID
  const urlObj = new URL(url);
  const instance = urlObj.hostname;

  // Extract post ID from path like /@username/123456
  const match = urlObj.pathname.match(/\/@[\w]+\/(\d+)/);
  if (!match) throw new Error('Invalid Mastodon URL');

  const postId = match[1];

  // Fetch from Mastodon API
  const apiUrl = `https://${instance}/api/v1/statuses/${postId}`;
  const data = await fetchJSON(apiUrl);

  // Get avatar
  const avatarUrl = data.account?.avatar || '';
  const avatarBase64 = await imageToBase64(avatarUrl);

  // Get media attachments
  const images = [];
  if (data.media_attachments) {
    for (const media of data.media_attachments) {
      if (media.type === 'image' || media.type === 'gifv') {
        images.push(media.url || media.preview_url);
      } else if (media.type === 'video') {
        images.push(media.preview_url);
      }
    }
  }

  const imagesBase64 = [];
  for (const imgUrl of images) {
    const base64 = await imageToBase64(imgUrl);
    if (base64) imagesBase64.push(base64);
  }

  // Strip HTML from content
  const content = data.content?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '';

  return {
    platform: 'mastodon',
    instance: instance,
    author: {
      name: data.account?.display_name || data.account?.username || 'Unknown',
      handle: `@${data.account?.username}@${instance}`,
      avatar: avatarBase64,
      avatarUrl: avatarUrl,
    },
    content: content,
    images: imagesBase64,
    originalImageUrls: images, // Original URLs for download
    timestamp: data.created_at,
    metrics: {
      replies: data.replies_count || 0,
      boosts: data.reblogs_count || 0,
      favorites: data.favourites_count || 0,
    },
    url: url,
  };
}

/**
 * Threads Scraper
 */
async function scrapeThreads(url) {
  // Threads doesn't have a public API, so we'll scrape the page
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  // Try to extract data from meta tags and page content
  const title = $('meta[property="og:title"]').attr('content') || '';
  const description = $('meta[property="og:description"]').attr('content') || '';
  const image = $('meta[property="og:image"]').attr('content') || '';

  // Parse author from title (usually "Author on Threads")
  const authorMatch = title.match(/^(.+?)\s+on\s+Threads/i);
  const authorName = authorMatch ? authorMatch[1] : 'Unknown';

  const avatarBase64 = await imageToBase64(image);

  return {
    platform: 'threads',
    author: {
      name: authorName,
      handle: authorName.toLowerCase().replace(/\s/g, ''),
      avatar: avatarBase64,
      avatarUrl: image,
    },
    content: description,
    images: [],
    originalImageUrls: [], // No images available from meta tags
    timestamp: null,
    metrics: {},
    url: url,
  };
}

/**
 * Article/Newsletter Scraper
 */
async function scrapeArticle(url) {
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const title = $('meta[property="og:title"]').attr('content') ||
                $('title').text() || 'Article';
  const description = $('meta[property="og:description"]').attr('content') ||
                      $('meta[name="description"]').attr('content') || '';
  const image = $('meta[property="og:image"]').attr('content') || '';
  const siteName = $('meta[property="og:site_name"]').attr('content') ||
                   new URL(url).hostname;
  const favicon = $('link[rel="icon"]').attr('href') ||
                  $('link[rel="shortcut icon"]').attr('href') || '';

  const imageBase64 = await imageToBase64(image);
  let faviconBase64 = null;
  let faviconUrl = '';
  if (favicon) {
    faviconUrl = favicon.startsWith('http') ? favicon : new URL(favicon, url).href;
    faviconBase64 = await imageToBase64(faviconUrl);
  }

  return {
    platform: 'article',
    siteName: siteName,
    title: title,
    description: description.slice(0, 300),
    image: imageBase64,
    imageUrl: image,
    originalImageUrls: image ? [image] : [], // Original image URL for download
    favicon: faviconBase64,
    faviconUrl: faviconUrl,
    url: url,
  };
}

/**
 * YouTube Scraper (oEmbed + meta tag fallback)
 */
async function scrapeYouTube(url) {
  const videoId = extractYouTubeId(url);
  let oembed = null;
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    oembed = await fetchJSON(oembedUrl);
  } catch (e) {
    oembed = null;
  }

  let title = oembed?.title || '';
  let authorName = oembed?.author_name || '';
  let authorUrl = oembed?.author_url || '';
  let thumbnailUrl = oembed?.thumbnail_url || '';
  let description = '';

  if (!title || !thumbnailUrl || !description) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      if (!title) {
        title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'YouTube';
      }
      if (!description) {
        description = $('meta[name="description"]').attr('content') ||
                      $('meta[property="og:description"]').attr('content') || '';
      }
      if (!thumbnailUrl) {
        thumbnailUrl = $('meta[property="og:image"]').attr('content') || '';
      }
    } catch (e) {
      // ignore
    }
  }

  if (!thumbnailUrl && videoId) {
    thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  }

  const thumbnailBase64 = await imageToBase64(thumbnailUrl);

  return {
    platform: 'youtube',
    author: {
      name: authorName || 'YouTube',
      handle: authorUrl ? authorUrl.replace(/^https?:\/\//, '') : '',
      avatar: null,
      avatarUrl: '',
    },
    title: title || 'YouTube Video',
    description: description.slice(0, 300),
    thumbnail: thumbnailBase64,
    thumbnailUrl: thumbnailUrl,
    originalImageUrls: thumbnailUrl ? [thumbnailUrl] : [],
    video: {
      id: videoId,
      url: url,
      authorUrl: authorUrl,
    },
    url: url,
  };
}

/**
 * TikTok Scraper (oEmbed + meta tag fallback)
 */
async function scrapeTikTok(url) {
  let oembed = null;
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    oembed = await fetchJSON(oembedUrl);
  } catch (e) {
    oembed = null;
  }

  let title = oembed?.title || '';
  let authorName = oembed?.author_name || '';
  let authorUrl = oembed?.author_url || '';
  let thumbnailUrl = oembed?.thumbnail_url || '';
  let description = '';

  if (!title || !thumbnailUrl || !description) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      if (!title) {
        title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'TikTok';
      }
      if (!description) {
        description = $('meta[property="og:description"]').attr('content') ||
                      $('meta[name="description"]').attr('content') || '';
      }
      if (!thumbnailUrl) {
        thumbnailUrl = $('meta[property="og:image"]').attr('content') || '';
      }
    } catch (e) {
      // ignore
    }
  }

  const thumbnailBase64 = await imageToBase64(thumbnailUrl);
  const handle = authorName ? (authorName.startsWith('@') ? authorName : `@${authorName}`) : '';

  return {
    platform: 'tiktok',
    author: {
      name: authorName || 'TikTok',
      handle: handle,
      avatar: null,
      avatarUrl: '',
    },
    title: title || 'TikTok Video',
    description: description.slice(0, 300),
    thumbnail: thumbnailBase64,
    thumbnailUrl: thumbnailUrl,
    originalImageUrls: thumbnailUrl ? [thumbnailUrl] : [],
    video: {
      url: url,
      authorUrl: authorUrl,
    },
    url: url,
  };
}

// ============================================================================
// HTML TEMPLATES
// ============================================================================

/**
 * Twitter/X Card Template (Dark mode style)
 */
function renderTwitterCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Tweet image">`).join('')}
    </div>
  ` : '';

  const verifiedBadge = data.author.verified ? `
    <svg class="verified" viewBox="0 0 22 22" width="18" height="18">
      <path fill="#1D9BF0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681.132-.637.075-1.299-.165-1.903.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/>
    </svg>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #16181c;
          border-radius: 16px;
          padding: 16px;
          max-width: ${CARD_WIDTH}px;
          border: 1px solid #2f3336;
        }
        .header {
          display: flex;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        .avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info {
          flex: 1;
        }
        .author-name {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .name {
          color: #e7e9ea;
          font-weight: 700;
          font-size: 15px;
        }
        .verified {
          flex-shrink: 0;
        }
        .handle {
          color: #71767b;
          font-size: 15px;
        }
        .time {
          color: #71767b;
          font-size: 15px;
        }
        .content {
          color: #e7e9ea;
          font-size: 15px;
          line-height: 1.4;
          margin-bottom: 12px;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        .images {
          border-radius: 16px;
          overflow: hidden;
          margin-bottom: 12px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 300px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          justify-content: space-between;
          color: #71767b;
          font-size: 13px;
          padding-top: 12px;
          border-top: 1px solid #2f3336;
        }
        .metric {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .metric svg {
          width: 18px;
          height: 18px;
          fill: #71767b;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2f3336;"></div>'}
          <div class="author-info">
            <div class="author-name">
              <span class="name">${escapeHtml(data.author.name)}</span>
              ${verifiedBadge}
            </div>
            <div class="handle">@${escapeHtml(data.author.handle)} · ${formatRelativeTime(data.timestamp)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <div class="metric">
            <svg viewBox="0 0 24 24"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg>
            <span>${formatNumber(data.metrics.replies)}</span>
          </div>
          <div class="metric">
            <svg viewBox="0 0 24 24"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg>
            <span>${formatNumber(data.metrics.retweets)}</span>
          </div>
          <div class="metric">
            <svg viewBox="0 0 24 24"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>
            <span>${formatNumber(data.metrics.likes)}</span>
          </div>
          ${data.metrics.views ? `
            <div class="metric">
              <svg viewBox="0 0 24 24"><path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg>
              <span>${formatNumber(data.metrics.views)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Twitter Thread Card Template - Combined view of multiple tweets
 */
function renderTwitterThreadCard(threadData) {
  const tweetsHtml = threadData.tweets.map((tweet, index) => {
    const imagesHtml = tweet.images.length > 0 ? `
      <div class="tweet-images ${tweet.images.length > 1 ? 'grid' : ''}">
        ${tweet.images.map(img => `<img src="${img}" alt="Tweet image">`).join('')}
      </div>
    ` : '';

    const isLast = index === threadData.tweets.length - 1;

    return `
      <div class="tweet ${tweet.isMainTweet ? 'main-tweet' : ''}">
        <div class="tweet-connector">
          <div class="avatar-wrapper">
            ${tweet.author.avatar ? `<img class="avatar" src="${tweet.author.avatar}" alt="Avatar">` : '<div class="avatar placeholder"></div>'}
          </div>
          ${!isLast ? '<div class="connector-line"></div>' : ''}
        </div>
        <div class="tweet-content">
          <div class="tweet-header">
            <span class="name">${escapeHtml(tweet.author.name)}</span>
            <span class="handle">@${escapeHtml(tweet.author.handle)}</span>
            <span class="time">· ${formatRelativeTime(tweet.timestamp)}</span>
          </div>
          <div class="tweet-text">${escapeHtml(tweet.content)}</div>
          ${imagesHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #16181c;
          border-radius: 16px;
          padding: 16px;
          max-width: ${CARD_WIDTH}px;
          border: 1px solid #2f3336;
        }
        .tweet {
          display: flex;
          gap: 12px;
          margin-bottom: 0;
        }
        .tweet.main-tweet .tweet-text {
          font-size: 16px;
        }
        .tweet-connector {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 40px;
          flex-shrink: 0;
        }
        .avatar-wrapper {
          flex-shrink: 0;
        }
        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          object-fit: cover;
        }
        .avatar.placeholder {
          background: #2f3336;
        }
        .connector-line {
          width: 2px;
          flex-grow: 1;
          background: #2f3336;
          min-height: 20px;
          margin: 4px 0;
        }
        .tweet-content {
          flex: 1;
          padding-bottom: 16px;
        }
        .tweet:last-child .tweet-content {
          padding-bottom: 0;
        }
        .tweet-header {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-bottom: 4px;
          flex-wrap: wrap;
        }
        .name {
          color: #e7e9ea;
          font-weight: 700;
          font-size: 14px;
        }
        .handle {
          color: #71767b;
          font-size: 14px;
        }
        .time {
          color: #71767b;
          font-size: 14px;
        }
        .tweet-text {
          color: #e7e9ea;
          font-size: 14px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        .tweet-images {
          border-radius: 12px;
          overflow: hidden;
          margin-top: 12px;
        }
        .tweet-images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .tweet-images img {
          width: 100%;
          display: block;
          max-height: 200px;
          object-fit: cover;
        }
      </style>
    </head>
    <body>
      <div class="card">
        ${tweetsHtml}
      </div>
    </body>
    </html>
  `;
}

/**
 * MacRumors Card Template
 */
function renderMacrumorsCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #fff;
          border-radius: 12px;
          overflow: hidden;
          max-width: ${CARD_WIDTH}px;
          display: flex;
        }
        .sidebar {
          background: #f8f9fa;
          padding: 16px;
          text-align: center;
          min-width: 100px;
          border-right: 1px solid #e9ecef;
        }
        .avatar {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          margin-bottom: 8px;
          object-fit: cover;
        }
        .author-name {
          color: #0066cc;
          font-weight: 600;
          font-size: 14px;
          margin-bottom: 4px;
        }
        .author-title {
          color: #6c757d;
          font-size: 12px;
        }
        .main {
          flex: 1;
          padding: 16px;
        }
        .post-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid #e9ecef;
        }
        .timestamp {
          color: #6c757d;
          font-size: 12px;
        }
        .post-number {
          background: #0066cc;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
        }
        .content {
          color: #212529;
          font-size: 14px;
          line-height: 1.5;
        }
        .images {
          margin-top: 12px;
        }
        .images img {
          max-width: 100%;
          border-radius: 8px;
          margin-bottom: 8px;
        }
        .reactions {
          margin-top: 12px;
          color: #6c757d;
          font-size: 12px;
        }
        .arrow-btn {
          position: absolute;
          right: 16px;
          bottom: 16px;
          width: 32px;
          height: 32px;
          background: #0066cc;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .arrow-btn svg {
          fill: white;
          width: 16px;
          height: 16px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="sidebar">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#e9ecef;"></div>'}
          <div class="author-name">${escapeHtml(data.author.name)}</div>
          <div class="author-title">${escapeHtml(data.author.title || 'member')}</div>
        </div>
        <div class="main">
          <div class="post-header">
            <span class="timestamp">${formatRelativeTime(data.timestamp)}</span>
            ${data.postNumber ? `<span class="post-number">#${data.postNumber}</span>` : ''}
          </div>
          <div class="content">${escapeHtml(data.content)}</div>
          ${imagesHtml}
          ${data.reactions ? `<div class="reactions">${escapeHtml(data.reactions)}</div>` : ''}
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bluesky Card Template
 */
function renderBlueskyCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #161e27;
          border-radius: 12px;
          padding: 16px;
          max-width: ${CARD_WIDTH}px;
          border: 1px solid #2a3f54;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
        }
        .avatar {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 15px;
        }
        .handle {
          color: #7b8d9d;
          font-size: 14px;
        }
        .content {
          color: #fff;
          font-size: 15px;
          line-height: 1.4;
          margin-bottom: 12px;
          white-space: pre-wrap;
        }
        .images {
          border-radius: 12px;
          overflow: hidden;
          margin-bottom: 12px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 280px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          gap: 24px;
          color: #7b8d9d;
          font-size: 13px;
        }
        .metric {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .timestamp {
          color: #7b8d9d;
          font-size: 13px;
          margin-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2a3f54;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="handle">@${escapeHtml(data.author.handle)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <span class="metric">💬 ${formatNumber(data.metrics.replies)}</span>
          <span class="metric">🔄 ${formatNumber(data.metrics.reposts)}</span>
          <span class="metric">❤️ ${formatNumber(data.metrics.likes)}</span>
        </div>
        <div class="timestamp">${formatRelativeTime(data.timestamp)}</div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Mastodon Card Template
 */
function renderMastodonCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #282c37;
          border-radius: 8px;
          padding: 16px;
          max-width: ${CARD_WIDTH}px;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
        }
        .avatar {
          width: 46px;
          height: 46px;
          border-radius: 8px;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 15px;
        }
        .handle {
          color: #9baec8;
          font-size: 14px;
        }
        .content {
          color: #fff;
          font-size: 15px;
          line-height: 1.5;
          margin-bottom: 12px;
        }
        .images {
          border-radius: 8px;
          overflow: hidden;
          margin-bottom: 12px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 280px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          gap: 20px;
          color: #9baec8;
          font-size: 14px;
          padding-top: 12px;
          border-top: 1px solid #393f4f;
        }
        .metric {
          display: flex;
          align-items: center;
          gap: 6px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#393f4f;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="handle">${escapeHtml(data.author.handle)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <span class="metric">💬 ${formatNumber(data.metrics.replies)}</span>
          <span class="metric">🔁 ${formatNumber(data.metrics.boosts)}</span>
          <span class="metric">⭐ ${formatNumber(data.metrics.favorites)}</span>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Article Card Template
 */
function renderArticleCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #fff;
          border-radius: 12px;
          overflow: hidden;
          max-width: ${CARD_WIDTH}px;
        }
        .image {
          width: 100%;
          height: 200px;
          object-fit: cover;
        }
        .content {
          padding: 16px;
        }
        .site {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .favicon {
          width: 20px;
          height: 20px;
          border-radius: 4px;
        }
        .site-name {
          color: #6c757d;
          font-size: 13px;
        }
        .title {
          color: #212529;
          font-size: 18px;
          font-weight: 600;
          line-height: 1.3;
          margin-bottom: 8px;
        }
        .description {
          color: #6c757d;
          font-size: 14px;
          line-height: 1.4;
        }
      </style>
    </head>
    <body>
      <div class="card">
        ${data.image ? `<img class="image" src="${data.image}" alt="Article image">` : ''}
        <div class="content">
          <div class="site">
            ${data.favicon ? `<img class="favicon" src="${data.favicon}" alt="">` : ''}
            <span class="site-name">${escapeHtml(data.siteName)}</span>
          </div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="description">${escapeHtml(data.description)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * YouTube Card Template
 */
function renderYouTubeCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #0f0f0f;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid #272727;
          max-width: ${CARD_WIDTH}px;
        }
        .thumbnail {
          position: relative;
          width: 100%;
          height: 310px;
          background: #1a1a1a;
        }
        .thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .play {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.65);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .play svg {
          width: 20px;
          height: 20px;
          fill: #fff;
          margin-left: 4px;
        }
        .content {
          padding: 16px 18px 18px;
        }
        .platform {
          color: #ff0000;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .title {
          color: #fff;
          font-size: 18px;
          font-weight: 600;
          line-height: 1.35;
          margin-bottom: 8px;
        }
        .author {
          color: #9a9a9a;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="thumbnail">
          ${data.thumbnail ? `<img src="${data.thumbnail}" alt="Video thumbnail">` : ''}
          <div class="play">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="content">
          <div class="platform">YouTube</div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="author">${escapeHtml(data.author.name)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * TikTok Card Template
 */
function renderTikTokCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000;
          padding: 20px;
        }
        .card {
          background: #0b0b0f;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid #23232f;
          max-width: ${CARD_WIDTH}px;
        }
        .thumbnail {
          position: relative;
          width: 100%;
          height: 310px;
          background: #1a1a1a;
        }
        .thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .play {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 56px;
          height: 56px;
          border-radius: 16px;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .play svg {
          width: 18px;
          height: 18px;
          fill: #fff;
          margin-left: 4px;
        }
        .content {
          padding: 16px 18px 18px;
        }
        .platform {
          color: #25f4ee;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .title {
          color: #fff;
          font-size: 17px;
          font-weight: 600;
          line-height: 1.35;
          margin-bottom: 8px;
        }
        .author {
          color: #9a9a9a;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="thumbnail">
          ${data.thumbnail ? `<img src="${data.thumbnail}" alt="Video thumbnail">` : ''}
          <div class="play">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="content">
          <div class="platform">TikTok</div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="author">${escapeHtml(data.author.handle || data.author.name)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ============================================================================
// BENTO STYLE TEMPLATES (Apple Keynote style)
// ============================================================================

/**
 * Bento Twitter/X Card Template
 */
function renderBentoTwitterCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Tweet image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          padding: 24px;
          max-width: ${CARD_WIDTH}px;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .avatar {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 16px;
          letter-spacing: -0.01em;
        }
        .handle {
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
        .content {
          color: #fff;
          font-size: 17px;
          line-height: 1.45;
          margin-bottom: 16px;
          white-space: pre-wrap;
          word-wrap: break-word;
          letter-spacing: -0.01em;
        }
        .images {
          border-radius: 16px;
          overflow: hidden;
          margin-bottom: 16px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 300px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          gap: 24px;
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
        .metric {
          display: flex;
          align-items: center;
          gap: 6px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2c2c2e;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="handle">@${escapeHtml(data.author.handle)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <span class="metric">${formatNumber(data.metrics.replies)} replies</span>
          <span class="metric">${formatNumber(data.metrics.retweets)} reposts</span>
          <span class="metric">${formatNumber(data.metrics.likes)} likes</span>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento Twitter Thread Card Template
 */
function renderBentoTwitterThreadCard(threadData) {
  const tweetsHtml = threadData.tweets.map((tweet, index) => {
    const imagesHtml = tweet.images.length > 0 ? `
      <div class="tweet-images ${tweet.images.length > 1 ? 'grid' : ''}">
        ${tweet.images.map(img => `<img src="${img}" alt="Tweet image">`).join('')}
      </div>
    ` : '';

    const isLast = index === threadData.tweets.length - 1;

    return `
      <div class="tweet">
        <div class="tweet-connector">
          <div class="avatar-wrapper">
            ${tweet.author.avatar ? `<img class="avatar" src="${tweet.author.avatar}" alt="Avatar">` : '<div class="avatar placeholder"></div>'}
          </div>
          ${!isLast ? '<div class="connector-line"></div>' : ''}
        </div>
        <div class="tweet-content">
          <div class="tweet-header">
            <span class="name">${escapeHtml(tweet.author.name)}</span>
            <span class="handle">@${escapeHtml(tweet.author.handle)}</span>
          </div>
          <div class="tweet-text">${escapeHtml(tweet.content)}</div>
          ${imagesHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          padding: 24px;
          max-width: ${CARD_WIDTH}px;
        }
        .tweet {
          display: flex;
          gap: 12px;
        }
        .tweet-connector {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 40px;
          flex-shrink: 0;
        }
        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          object-fit: cover;
        }
        .avatar.placeholder {
          background: #2c2c2e;
        }
        .connector-line {
          width: 2px;
          flex-grow: 1;
          background: #3a3a3c;
          min-height: 20px;
          margin: 4px 0;
        }
        .tweet-content {
          flex: 1;
          padding-bottom: 20px;
        }
        .tweet:last-child .tweet-content {
          padding-bottom: 0;
        }
        .tweet-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 4px;
        }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 15px;
          letter-spacing: -0.01em;
        }
        .handle {
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
        .tweet-text {
          color: #fff;
          font-size: 16px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-wrap: break-word;
          letter-spacing: -0.01em;
        }
        .tweet-images {
          border-radius: 12px;
          overflow: hidden;
          margin-top: 12px;
        }
        .tweet-images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .tweet-images img {
          width: 100%;
          display: block;
          max-height: 200px;
          object-fit: cover;
        }
      </style>
    </head>
    <body>
      <div class="card">
        ${tweetsHtml}
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento Bluesky Card Template
 */
function renderBentoBlueskyCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          padding: 24px;
          max-width: ${CARD_WIDTH}px;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .avatar {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 16px;
          letter-spacing: -0.01em;
        }
        .handle {
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
        .content {
          color: #fff;
          font-size: 17px;
          line-height: 1.45;
          margin-bottom: 16px;
          white-space: pre-wrap;
          letter-spacing: -0.01em;
        }
        .images {
          border-radius: 16px;
          overflow: hidden;
          margin-bottom: 16px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 280px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          gap: 24px;
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2c2c2e;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="handle">@${escapeHtml(data.author.handle)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <span class="metric">${formatNumber(data.metrics.replies)} replies</span>
          <span class="metric">${formatNumber(data.metrics.reposts)} reposts</span>
          <span class="metric">${formatNumber(data.metrics.likes)} likes</span>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento Mastodon Card Template
 */
function renderBentoMastodonCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images ${data.images.length > 1 ? 'grid' : ''}">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          padding: 24px;
          max-width: ${CARD_WIDTH}px;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .avatar {
          width: 44px;
          height: 44px;
          border-radius: 10px;
          margin-right: 12px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #fff;
          font-weight: 600;
          font-size: 16px;
          letter-spacing: -0.01em;
        }
        .handle {
          color: rgba(255,255,255,0.55);
          font-size: 13px;
        }
        .content {
          color: #fff;
          font-size: 17px;
          line-height: 1.45;
          margin-bottom: 16px;
          letter-spacing: -0.01em;
        }
        .images {
          border-radius: 16px;
          overflow: hidden;
          margin-bottom: 16px;
        }
        .images.grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
        }
        .images img {
          width: 100%;
          display: block;
          max-height: 280px;
          object-fit: cover;
        }
        .metrics {
          display: flex;
          gap: 24px;
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2c2c2e;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="handle">${escapeHtml(data.author.handle)}</div>
          </div>
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        <div class="metrics">
          <span class="metric">${formatNumber(data.metrics.replies)} replies</span>
          <span class="metric">${formatNumber(data.metrics.boosts)} boosts</span>
          <span class="metric">${formatNumber(data.metrics.favorites)} favorites</span>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento MacRumors Card Template
 */
function renderBentoMacrumorsCard(data) {
  const imagesHtml = data.images.length > 0 ? `
    <div class="images">
      ${data.images.map(img => `<img src="${img}" alt="Post image">`).join('')}
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          padding: 24px;
          max-width: ${CARD_WIDTH}px;
        }
        .header {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
        }
        .avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          margin-right: 14px;
          object-fit: cover;
        }
        .author-info { flex: 1; }
        .name {
          color: #0a84ff;
          font-weight: 600;
          font-size: 16px;
          letter-spacing: -0.01em;
        }
        .title {
          color: rgba(255,255,255,0.55);
          font-size: 13px;
        }
        .post-number {
          background: #0a84ff;
          color: white;
          padding: 4px 10px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
        }
        .content {
          color: #fff;
          font-size: 16px;
          line-height: 1.5;
          letter-spacing: -0.01em;
        }
        .images {
          margin-top: 16px;
        }
        .images img {
          max-width: 100%;
          border-radius: 12px;
          margin-bottom: 8px;
        }
        .reactions {
          margin-top: 16px;
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          ${data.author.avatar ? `<img class="avatar" src="${data.author.avatar}" alt="Avatar">` : '<div class="avatar" style="background:#2c2c2e;"></div>'}
          <div class="author-info">
            <div class="name">${escapeHtml(data.author.name)}</div>
            <div class="title">${escapeHtml(data.author.title || 'member')}</div>
          </div>
          ${data.postNumber ? `<span class="post-number">#${data.postNumber}</span>` : ''}
        </div>
        <div class="content">${escapeHtml(data.content)}</div>
        ${imagesHtml}
        ${data.reactions ? `<div class="reactions">${escapeHtml(data.reactions)}</div>` : ''}
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento Article Card Template
 */
function renderBentoArticleCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          overflow: hidden;
          max-width: ${CARD_WIDTH}px;
        }
        .image {
          width: 100%;
          height: 200px;
          object-fit: cover;
        }
        .content {
          padding: 24px;
        }
        .site {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }
        .favicon {
          width: 20px;
          height: 20px;
          border-radius: 4px;
        }
        .site-name {
          color: rgba(255,255,255,0.55);
          font-size: 13px;
        }
        .title {
          color: #fff;
          font-size: 20px;
          font-weight: 600;
          line-height: 1.3;
          margin-bottom: 8px;
          letter-spacing: -0.02em;
        }
        .description {
          color: rgba(255,255,255,0.7);
          font-size: 15px;
          line-height: 1.45;
          letter-spacing: -0.01em;
        }
      </style>
    </head>
    <body>
      <div class="card">
        ${data.image ? `<img class="image" src="${data.image}" alt="Article image">` : ''}
        <div class="content">
          <div class="site">
            ${data.favicon ? `<img class="favicon" src="${data.favicon}" alt="">` : ''}
            <span class="site-name">${escapeHtml(data.siteName)}</span>
          </div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="description">${escapeHtml(data.description)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento YouTube Card Template
 */
function renderBentoYouTubeCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          overflow: hidden;
          max-width: ${CARD_WIDTH}px;
        }
        .thumbnail {
          position: relative;
          width: 100%;
          height: 220px;
          background: #2c2c2e;
        }
        .thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .play {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .play svg {
          width: 18px;
          height: 18px;
          fill: #fff;
          margin-left: 3px;
        }
        .content {
          padding: 22px 24px 24px;
        }
        .platform {
          color: #ff453a;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        }
        .title {
          color: #fff;
          font-size: 18px;
          font-weight: 600;
          line-height: 1.3;
          letter-spacing: -0.02em;
          margin-bottom: 8px;
        }
        .author {
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="thumbnail">
          ${data.thumbnail ? `<img src="${data.thumbnail}" alt="Video thumbnail">` : ''}
          <div class="play">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="content">
          <div class="platform">YouTube</div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="author">${escapeHtml(data.author.name)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Bento TikTok Card Template
 */
function renderBentoTikTokCard(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
          background: transparent;
          padding: 0;
        }
        .card {
          background: #1c1c1e;
          border-radius: 24px;
          overflow: hidden;
          max-width: ${CARD_WIDTH}px;
        }
        .thumbnail {
          position: relative;
          width: 100%;
          height: 220px;
          background: #2c2c2e;
        }
        .thumbnail img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .play {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 52px;
          height: 52px;
          border-radius: 16px;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .play svg {
          width: 18px;
          height: 18px;
          fill: #fff;
          margin-left: 3px;
        }
        .content {
          padding: 22px 24px 24px;
        }
        .platform {
          color: #25f4ee;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        }
        .title {
          color: #fff;
          font-size: 18px;
          font-weight: 600;
          line-height: 1.3;
          letter-spacing: -0.02em;
          margin-bottom: 8px;
        }
        .author {
          color: rgba(255,255,255,0.55);
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="thumbnail">
          ${data.thumbnail ? `<img src="${data.thumbnail}" alt="Video thumbnail">` : ''}
          <div class="play">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="content">
          <div class="platform">TikTok</div>
          <div class="title">${escapeHtml(data.title)}</div>
          <div class="author">${escapeHtml(data.author.handle || data.author.name)}</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// SCREENSHOT GENERATOR
// ============================================================================

async function generateScreenshot(html, filename) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });

  // Wait for images to load
  await page.evaluate(() => {
    return Promise.all(
      Array.from(document.images).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = resolve; // Don't fail on broken images
        });
      })
    );
  });

  // Get the card element dimensions
  const cardElement = await page.locator('.card');
  const boundingBox = await cardElement.boundingBox();

  // Screenshot with some padding
  const padding = 20;
  await page.screenshot({
    path: filename,
    clip: {
      x: boundingBox.x - padding,
      y: boundingBox.y - padding,
      width: boundingBox.width + (padding * 2),
      height: boundingBox.height + (padding * 2),
    },
    omitBackground: true // Transparent background
  });

  await page.close();
  return filename;
}

// ============================================================================
// PROCESS SINGLE URL
// ============================================================================

async function processUrl(url, index, total, outputDir, options = {}) {
  const prefix = total > 1 ? `[${index + 1}/${total}] ` : '';
  console.log(`${prefix}Processing: ${url}`);

  // Detect platform
  const platform = detectPlatform(url);

  if (platform === 'unknown') {
    console.log(`${prefix}  ⚠️  Unknown platform, skipping`);
    return { success: false, url, error: 'Unknown platform' };
  }

  try {
    // Scrape data based on platform
    let data;
    let html;
    let metadataSource;

    switch (platform) {
      case 'twitter':
        if (options.thread) {
          // Thread mode: fetch conversation and create combined card
          const threadData = await scrapeTwitterThread(url);
          html = options.bento ? renderBentoTwitterThreadCard(threadData) : renderTwitterThreadCard(threadData);
          // Collect all original images from all tweets
          data = {
            author: threadData.tweets[0]?.author || { name: 'Unknown' },
            originalImageUrls: threadData.tweets.flatMap(t => t.originalImageUrls || []),
          };
          metadataSource = threadData;
        } else {
          data = await scrapeTwitter(url);
          html = options.bento ? renderBentoTwitterCard(data) : renderTwitterCard(data);
          metadataSource = data;
        }
        break;
      case 'macrumors':
        data = await scrapeMacrumors(url);
        html = options.bento ? renderBentoMacrumorsCard(data) : renderMacrumorsCard(data);
        metadataSource = data;
        break;
      case 'bluesky':
        data = await scrapeBluesky(url);
        html = options.bento ? renderBentoBlueskyCard(data) : renderBlueskyCard(data);
        metadataSource = data;
        break;
      case 'mastodon':
        data = await scrapeMastodon(url);
        html = options.bento ? renderBentoMastodonCard(data) : renderMastodonCard(data);
        metadataSource = data;
        break;
      case 'threads':
        data = await scrapeThreads(url);
        html = options.bento ? renderBentoTwitterCard(data) : renderTwitterCard(data);
        metadataSource = data;
        break;
      case 'youtube':
        data = await scrapeYouTube(url);
        html = options.bento ? renderBentoYouTubeCard(data) : renderYouTubeCard(data);
        metadataSource = data;
        break;
      case 'tiktok':
        data = await scrapeTikTok(url);
        html = options.bento ? renderBentoTikTokCard(data) : renderTikTokCard(data);
        metadataSource = data;
        break;
      case 'article':
        data = await scrapeArticle(url);
        html = options.bento ? renderBentoArticleCard(data) : renderArticleCard(data);
        metadataSource = data;
        break;
      default:
        throw new Error('Platform not implemented');
    }

    const author = data.author?.name || data.siteName || 'Unknown';

    // Generate base filename (without extension)
    const baseFilename = generateFilename(url, platform).replace('.png', '');

    // Generate card screenshot
    const cardFilename = path.join(outputDir, `${baseFilename}-card.png`);
    await generateScreenshot(html, cardFilename);

    // Download original images
    const downloadedImages = [];
    if (data.originalImageUrls && data.originalImageUrls.length > 0) {
      for (let i = 0; i < data.originalImageUrls.length; i++) {
        const imgUrl = data.originalImageUrls[i];
        const ext = getImageExtension(imgUrl);
        const imgFilename = path.join(outputDir, `${baseFilename}-image-${i + 1}.${ext}`);
        const result = await downloadImage(imgUrl, imgFilename);
        if (result) {
          downloadedImages.push(path.basename(imgFilename));
        }
      }
    }

    const metadataFilename = path.join(outputDir, `${baseFilename}-metadata.json`);
    const metadataPayload = buildMetadataPayload(metadataSource || data, url, cardFilename, downloadedImages);
    fs.writeFileSync(metadataFilename, JSON.stringify(metadataPayload, null, 2));

    // Log results
    console.log(`${prefix}  ✅ ${author}`);
    console.log(`${prefix}     Card: ${path.basename(cardFilename)}`);
    if (downloadedImages.length > 0) {
      downloadedImages.forEach(img => console.log(`${prefix}     Image: ${img}`));
    }
    console.log(`${prefix}     Metadata: ${path.basename(metadataFilename)}`);

    return {
      success: true,
      url,
      cardFilename: path.basename(cardFilename),
      imageFilenames: downloadedImages,
      metadataFilename: path.basename(metadataFilename),
      author
    };

  } catch (error) {
    console.log(`${prefix}  ❌ Error: ${error.message}`);
    return { success: false, url, error: error.message };
  }
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const config = parseArgs(args);

  // If --file flag is set, read URLs from file
  if (config.file) {
    try {
      const content = fs.readFileSync(config.file, 'utf-8');
      config.urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.startsWith('http'));
    } catch (e) {
      console.error(`❌ Could not read file: ${config.file}`);
      process.exit(1);
    }
  }

  if (config.urls.length === 0) {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Social Screenshot Tool                           ║
╠═══════════════════════════════════════════════════════════════╣
║  Generate clean screenshot cards from social media posts      ║
╠═══════════════════════════════════════════════════════════════╣
║  USAGE:                                                       ║
║                                                               ║
║  Single URL:                                                  ║
║    node screenshot.js <url>                                   ║
║                                                               ║
║  Multiple URLs:                                               ║
║    node screenshot.js <url1> <url2> <url3>                    ║
║                                                               ║
║  From file (one URL per line):                                ║
║    node screenshot.js --file urls.txt                         ║
║                                                               ║
║  OPTIONS:                                                     ║
║    --output <folder>   Save screenshots to custom folder      ║
║    --parallel <n>      Process n URLs at once (default: 3)    ║
║    --thread            Capture threads/replies as one card    ║
║    --bento             Apple bento style for Keynote slides   ║
║                                                               ║
║  EXAMPLES:                                                    ║
║    node screenshot.js --file urls.txt --output ./slides       ║
║    node screenshot.js --file urls.txt --parallel 5            ║
║    node screenshot.js --thread <twitter-url>                  ║
║    node screenshot.js --bento <url>                           ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║  SUPPORTED PLATFORMS:                                         ║
║  • Twitter/X        • Bluesky         • Threads               ║
║  • MacRumors Forums • Mastodon        • Articles              ║
║  • YouTube          • TikTok                                  ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(config.output)) {
    fs.mkdirSync(config.output, { recursive: true });
  }

  // Print header
  console.log(`\n📸 Social Screenshot Tool`);
  if (config.urls.length > 1) {
    console.log(`Processing ${config.urls.length} URLs (${config.parallel} parallel)\n`);
  } else {
    console.log('');
  }

  // Process URLs
  const startTime = Date.now();
  let results;
  const options = { thread: config.thread, bento: config.bento };

  if (config.urls.length === 1) {
    // Single URL - process directly
    const result = await processUrl(config.urls[0], 0, 1, config.output, options);
    results = [result];
  } else {
    // Multiple URLs - process in parallel
    results = await processInParallel(config.urls, config.output, config.parallel, options);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Close browser
  await closeBrowser();

  // Print summary for batch operations
  if (config.urls.length > 1) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const totalImages = successful.reduce((sum, r) => sum + (r.imageFilenames?.length || 0), 0);

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`SUMMARY (${elapsed}s)`);
    console.log(`${'═'.repeat(50)}`);
    console.log(`✅ Posts processed: ${successful.length}`);
    console.log(`📷 Cards saved: ${successful.length}`);
    console.log(`🖼️  Images saved: ${totalImages}`);
    if (failed.length > 0) {
      console.log(`❌ Failed: ${failed.length}`);
      failed.forEach(r => console.log(`   • ${r.url.slice(0, 50)}...`));
    }
    console.log(`\n📁 Output: ${config.output}`);
  }

  console.log('');
}

main().catch(e => {
  console.error(`\n❌ Fatal error: ${e.message}\n`);
  closeBrowser().then(() => process.exit(1));
});
