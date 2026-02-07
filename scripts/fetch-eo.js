const fs = require('fs');
const path = require('path');

const API = 'https://fantasy.premierleague.com/api';
const TOP_N = 10000;
const ENTRIES_PER_PAGE = 50;
const CONCURRENCY = 10;
const OVERALL_LEAGUE = 314;

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function runPool(tasks, concurrency, onProgress) {
  const results = new Array(tasks.length);
  let next = 0, completed = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          results[idx] = await tasks[idx]();
          break;
        } catch (e) {
          if (attempt === 2) { results[idx] = null; console.warn(`Failed after 3 attempts: task ${idx}`); }
          else await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      completed++;
      if (onProgress) onProgress(completed, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  console.log('Fetching bootstrap data...');
  const bootstrap = await apiFetch(`${API}/bootstrap-static/`);
  const currentEvent = bootstrap.events.find(e => e.is_current);
  if (!currentEvent) { console.log('No active gameweek. Skipping.'); process.exit(0); }
  const gw = currentEvent.id;
  console.log(`Current gameweek: ${gw}`);

  // Fetch top 10k manager IDs from overall standings
  const pages = Math.ceil(TOP_N / ENTRIES_PER_PAGE);
  console.log(`Fetching ${pages} standings pages...`);
  const standingsTasks = Array.from({ length: pages }, (_, i) =>
    () => apiFetch(`${API}/leagues-classic/${OVERALL_LEAGUE}/standings/?page_standings=${i + 1}`)
  );
  const standingsResults = await runPool(standingsTasks, CONCURRENCY, (done, total) => {
    if (done % 20 === 0 || done === total) process.stdout.write(`\r  Standings: ${done}/${total}`);
  });
  console.log('');

  const managerIds = [];
  for (const res of standingsResults) {
    if (res && res.standings && res.standings.results) {
      for (const entry of res.standings.results) managerIds.push(entry.entry);
    }
  }
  console.log(`Found ${managerIds.length} managers`);

  // Fetch picks for each manager
  console.log(`Fetching picks for GW${gw}...`);
  const picksTasks = managerIds.slice(0, TOP_N).map(id =>
    () => apiFetch(`${API}/entry/${id}/event/${gw}/picks/`)
  );
  const picksResults = await runPool(picksTasks, CONCURRENCY, (done, total) => {
    if (done % 200 === 0 || done === total) process.stdout.write(`\r  Picks: ${done}/${total}`);
  });
  console.log('');

  // Aggregate into EO
  const players = {};
  let totalManagers = 0;
  for (const pd of picksResults) {
    if (!pd || !pd.picks) continue;
    totalManagers++;
    for (const pick of pd.picks) {
      if (!players[pick.element]) players[pick.element] = { multiplierSum: 0, selected: 0, captained: 0, tripled: 0 };
      const p = players[pick.element];
      p.selected++;
      p.multiplierSum += pick.multiplier;
      if (pick.multiplier === 2) p.captained++;
      if (pick.multiplier === 3) p.tripled++;
    }
  }
  for (const id in players) {
    players[id].eo = totalManagers > 0 ? (players[id].multiplierSum / totalManagers * 100) : 0;
  }

  const output = {
    gameweek: gw,
    totalManagers,
    players,
    updatedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, '..', 'data', 'eo-top10k.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`Written to ${outPath} (${totalManagers} managers, ${Object.keys(players).length} players)`);
}

main().catch(e => { console.error(e); process.exit(1); });
