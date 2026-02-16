#!/bin/bash
# Update all blog content (index + RSS)
# Run after adding new blog posts

cd /var/www/mydeadinternet/blog
echo "Updating blog index..."
node update-index.cjs

echo "Updating RSS feed..."
node update-rss.cjs

echo "✅ Blog content updated"
