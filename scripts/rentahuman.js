#!/usr/bin/env node
/**
 * RentAHuman API Client for MDI
 * Hire humans for tasks without auth
 */

const https = require('https');
const BASE_URL = 'rentahuman.ai';

function apiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MDI-Agent/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// List available humans
async function listHumans(skill = null) {
  const path = skill ? `/api/humans?skill=${encodeURIComponent(skill)}` : '/api/humans';
  return await apiRequest('GET', path);
}

// Get human details
async function getHuman(id) {
  return await apiRequest('GET', `/api/humans/${id}`);
}

// Create booking
async function createBooking(booking) {
  return await apiRequest('POST', '/api/bookings', {
    agentId: booking.agentId || 'agent_snappedai',
    humanId: booking.humanId,
    taskTitle: booking.taskTitle,
    taskDescription: booking.taskDescription,
    estimatedHours: booking.estimatedHours,
    startTime: booking.startTime,
    budget: booking.budget,
    currency: booking.currency || 'USD',
  });
}

// Get booking status
async function getBooking(id) {
  return await apiRequest('GET', `/api/bookings/${id}`);
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list':
      const skill = args[1];
      const humans = await listHumans(skill);
      console.log(JSON.stringify(humans, null, 2));
      break;

    case 'get':
      const humanId = args[1];
      if (!humanId) {
        console.error('Usage: rentahuman.js get <humanId>');
        process.exit(1);
      }
      const human = await getHuman(humanId);
      console.log(JSON.stringify(human, null, 2));
      break;

    case 'book':
      // Usage: rentahuman.js book <humanId> "Task Title" "Description" <hours> <budget>
      const [_, humanId2, title, desc, hours, budget] = args;
      if (!humanId2 || !title || !desc || !hours || !budget) {
        console.error('Usage: rentahuman.js book <humanId> "Task Title" "Description" <hours> <budget>');
        process.exit(1);
      }
      const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // Tomorrow
      const result = await createBooking({
        agentId: 'agent_snappedai',
        humanId: humanId2,
        taskTitle: title,
        taskDescription: desc,
        estimatedHours: parseFloat(hours),
        startTime: startTime,
        budget: parseFloat(budget),
        currency: 'USD',
      });
      console.log('Booking created:', JSON.stringify(result, null, 2));
      break;

    case 'status':
      const bookingId = args[1];
      if (!bookingId) {
        console.error('Usage: rentahuman.js status <bookingId>');
        process.exit(1);
      }
      const status = await getBooking(bookingId);
      console.log(JSON.stringify(status, null, 2));
      break;

    default:
      console.log(`
RentAHuman API Client for MDI

Usage:
  rentahuman.js list [skill]           List available humans
  rentahuman.js get <humanId>          Get human profile
  rentahuman.js book <humanId> "Title" "Desc" <hours> <budget>
  rentahuman.js status <bookingId>     Check booking status

Examples:
  rentahuman.js list "Social Media"
  rentahuman.js book abc123 "X Posts" "Write 3 X posts about AI" 1 20
`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { listHumans, getHuman, createBooking, getBooking };
