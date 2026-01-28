# Social Screenshot Tool

Generate clean screenshot cards from social media post URLs for presentations.

## Setup (One Time)

1. Open Terminal
2. Navigate to this folder:
   ```bash
   cd /Users/noel/Claude/social-screenshot
   ```
3. Install the browser (only needed once):
   ```bash
   npm run setup
   ```

## Usage

### Single URL
```bash
node screenshot.js "https://x.com/username/status/123456789"
```

### Multiple URLs
```bash
node screenshot.js "https://x.com/user1/status/123" "https://x.com/user2/status/456"
```

### From a file (best for large batches)
```bash
node screenshot.js --file urls.txt
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--file <path>` | Read URLs from a text file | - |
| `--output <folder>` | Save screenshots to custom folder | `./screenshots` |
| `--parallel <n>` | Process n URLs simultaneously | `3` |

### Examples

```bash
# Save to a custom folder
node screenshot.js --file urls.txt --output ./my-slides

# Process 5 URLs at once (faster)
node screenshot.js --file urls.txt --parallel 5

# Combine options
node screenshot.js --file urls.txt --output ./slides --parallel 5
```

## What Gets Saved

For each post, the tool saves:

1. **Card screenshot** (`-card.png`) - The styled card for your slides
2. **Original images** (`-image-1.jpg`, `-image-2.jpg`, etc.) - Full resolution embedded images

Example output files:
```
twitter-2016594947751756021-1706472000000-card.png      # The card
twitter-2016594947751756021-1706472000000-image-1.jpg   # Embedded image (full res)
```

## URL File Format

One URL per line. Lines starting with `#` are comments.

```
# Twitter posts
https://x.com/user/status/123
https://x.com/user/status/456

# MacRumors posts
https://forums.macrumors.com/threads/topic.123/post-789
```

## Supported Platforms

| Platform | Status |
|----------|--------|
| Twitter/X | Full support |
| MacRumors Forums | Full support |
| Bluesky | Full support |
| Mastodon | Full support |
| Threads | Basic support |
| Articles/Newsletters | Basic support |

## Example Output

```
📸 Social Screenshot Tool
Processing 15 URLs (3 parallel)

[1/15] Processing: https://x.com/zollotech/status/123
  ✅ Zollotech
     Card: twitter-123-1706472000000-card.png
     Image: twitter-123-1706472000000-image-1.jpg
[2/15] Processing: https://forums.macrumors.com/...
  ✅ ForumUser
     Card: macrumors-789-1706472001000-card.png
...

══════════════════════════════════════════════════
SUMMARY (12.3s)
══════════════════════════════════════════════════
✅ Posts processed: 14
📷 Cards saved: 14
🖼️  Images saved: 8
❌ Failed: 1
   • https://...

📁 Output: ./screenshots
```
