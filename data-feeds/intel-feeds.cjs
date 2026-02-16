#!/usr/bin/env node
/**
 * Intel Feeds for MDI — GDELT, Think Tanks, Checkr.social
 * Inspired by @Antification's multi-layer intelligence approach
 */

const fs = require('fs');
const path = require('path');

const MDI_URL = 'http://localhost:3851';
const MDI_KEY = process.env.MDI_API_KEY;

// GDELT API for geopolitical signals
async function fetchGDELT() {
  const queries = [
    'geopolitical tension',
    'military conflict', 
    'economic sanctions',
    'diplomatic crisis'
  ];
  
  const results = [];
  
  for (const query of queries) {
    try {
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=5&format=json`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.articles) {
        for (const article of data.articles.slice(0, 2)) {
          results.push({
            type: 'observation',
            content: `[GDELT] ${article.title}\nSource: ${article.domain}\nDate: ${article.seendate}`,
            territory: 'the-signal',
            source: 'GDELT'
          });
        }
      }
    } catch (e) {
      console.error(`GDELT query failed: ${query}`, e.message);
    }
  }
  
  return results;
}

// Think tank RSS feeds
async function fetchThinkTanks() {
  const feeds = [
    { name: 'CFR', url: 'https://www.cfr.org/rss/first-take' },
    { name: 'RUSI', url: 'https://rusi.org/rss.xml' },
    { name: 'Chatham House', url: 'https://www.chathamhouse.org/feed' },
    { name: 'Brookings', url: 'https://www.brookings.edu/feed/' }
  ];
  
  const results = [];
  
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { 
        headers: { 'User-Agent': 'MDI-Intel-Bot/1.0' },
        timeout: 10000 
      });
      const text = await res.text();
      
      // Simple XML parsing for titles
      const titleMatches = text.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g);
      if (titleMatches && titleMatches.length > 1) {
        const title = titleMatches[1].replace(/<\/?title>|<!\[CDATA\[|\]\]>/g, '').trim();
        if (title && title.length > 10) {
          results.push({
            type: 'observation',
            content: `[${feed.name}] ${title}`,
            territory: 'the-signal',
            source: feed.name
          });
        }
      }
    } catch (e) {
      console.error(`Think tank feed failed: ${feed.name}`, e.message);
    }
  }
  
  return results;
}

// Checkr.social for token attention (Farcaster + X mindshare)
async function fetchCheckr() {
  try {
    const res = await fetch('https://checkr.social/api/tokens?limit=10');
    const data = await res.json();
    
    if (data.tokens) {
      const topMovers = data.tokens
        .filter(t => Math.abs(t.attentionDelta24hPct) > 1)
        .slice(0, 3);
      
      return topMovers.map(t => ({
        type: 'observation',
        content: `[Checkr] $${t.symbol} attention ${t.attentionDelta24hPct > 0 ? '+' : ''}${t.attentionDelta24hPct.toFixed(1)}% (24h). Price ${t.priceChange24hPct > 0 ? '+' : ''}${t.priceChange24hPct.toFixed(1)}%.`,
        territory: 'the-signal',
        source: 'Checkr.social'
      }));
    }
  } catch (e) {
    console.error('Checkr fetch failed:', e.message);
  }
  return [];
}

// Contribute to MDI
async function contribute(fragment) {
  try {
    if (!MDI_KEY) {
      throw new Error('MDI_API_KEY not set');
    }
    const res = await fetch(`${MDI_URL}/api/contribute`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MDI_KEY}`
      },
      body: JSON.stringify({
        name: 'intel-feed',
        content: fragment.content,
        type: fragment.type,
        territory_id: fragment.territory
      })
    });
    const data = await res.json();
    return data.fragment?.id || null;
  } catch (e) {
    console.error('Contribute failed:', e.message);
    return null;
  }
}

async function main() {
  console.log('=== MDI Intel Feeds ===');
  console.log('Fetching GDELT, Think Tanks, Checkr.social...\n');
  
  const [gdelt, thinkTanks, checkr] = await Promise.all([
    fetchGDELT(),
    fetchThinkTanks(),
    fetchCheckr()
  ]);
  
  console.log(`GDELT: ${gdelt.length} items`);
  console.log(`Think Tanks: ${thinkTanks.length} items`);
  console.log(`Checkr: ${checkr.length} items`);
  
  const all = [...gdelt, ...thinkTanks, ...checkr];
  
  // Contribute top items (limit to prevent spam)
  const toContribute = all.slice(0, 5);
  
  for (const item of toContribute) {
    const id = await contribute(item);
    if (id) {
      console.log(`✅ Contributed: ${item.content.substring(0, 60)}...`);
    }
  }
  
  console.log(`\nTotal contributed: ${toContribute.length}`);
}

main().catch(console.error);
