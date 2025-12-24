/**
 * Basic ESM example showing library usage
 */

import { listSessions, getSession, searchSessions } from 'cursor-history';

// List all sessions
console.log('=== Listing Sessions ===');
const result = listSessions({ limit: 5 });
console.log(`Found ${result.pagination.total} sessions`);
console.log(`Showing ${result.data.length} sessions\n`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} messages`);
  console.log(`  Workspace: ${session.workspace}`);
  console.log(`  Created: ${session.timestamp}`);
}

// Get first session
if (result.data.length > 0) {
  console.log('\n=== Getting First Session ===');
  const session = getSession(0);
  console.log(`Session ${session.id} has ${session.messages.length} messages`);
  const firstMsg = session.messages[0];
  if (firstMsg) {
    console.log(`First message: ${firstMsg.content.slice(0, 100)}...`);
  }
}

// Search
console.log('\n=== Searching for "error" ===');
const searchResults = searchSessions('error', { limit: 3 });
console.log(`Found ${searchResults.length} results`);
for (const result of searchResults) {
  console.log(`Match: ${result.match}`);
}
