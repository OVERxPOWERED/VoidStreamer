const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
  const url = 'https://movibox.net/movie';
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    timeout: 15000
  });
  console.log('Status:', res.status);
  console.log('Length:', res.data.length);
  
  const $ = cheerio.load(res.data);
  console.log('Title:', $('title').text());

  const nuxtMatch = res.data.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nuxtMatch) {
    const payload = JSON.parse(nuxtMatch[1]);
    console.log('Nuxt payload length:', payload.length);
    
    // Look at rows/sections in the Nuxt data
    for (let i = 0; i < Math.min(20, payload.length); i++) {
      const t = typeof payload[i];
      const v = Array.isArray(payload[i]) ? '[' + payload[i].length + ']' : payload[i];
      console.log(i + ':', t, typeof v === 'string' && v.length > 100 ? v.substring(0,100) + '...' : v);
    }
    
    // Check for section names or category titles
    console.log('\n--- Looking for section/category titles ---');
    for (let i = 0; i < payload.length; i++) {
      if (typeof payload[i] === 'string' && /[A-Z]/.test(payload[i][0]) && payload[i].length > 3 && payload[i].length < 60) {
        const next = payload[i+1];
        const nextType = typeof next;
        if (nextType === 'string' || Array.isArray(next)) {
          console.log(i + ': "' + payload[i] + '" -> ' + nextType + (Array.isArray(next) ? '[' + next.length + ']' : ''));
        }
      }
    }

    // Check the first few arrays for structure
    console.log('\n--- Checking arrays ---');
    for (let i = 0; i < Math.min(30, payload.length); i++) {
      if (Array.isArray(payload[i])) {
        console.log(i + ': array[' + payload[i].length + '] first:', JSON.stringify(payload[i].slice(0, 3)));
      }
    }

    // Check for movie cards in the DOM
    console.log('\n--- DOM card structure ---');
    $('.pc-card, [class*="card"], [class*="poster"]').slice(0, 8).each((i, el) => {
      console.log($(el).prop('tagName'), $(el).attr('class'));
      const img = $(el).find('img').first();
      if (img.length) console.log('  img:', img.attr('src') || img.attr('data-src') || '(none)');
      const a = $(el).find('a').first();
      if (a.length) console.log('  href:', a.attr('href'));
    });

    // Check links with href containing movie detail
    console.log('\n--- Movie links ---');
    $('a[href*="/detail/"], a[href*="/movie/"], a[href*="/watch/"]').slice(0, 15).each((i, el) => {
      console.log('  [' + i + ']', $(el).attr('href'), $(el).find('img').attr('alt') || $(el).text().trim().substring(0, 60));
    });
  }
}

test().catch(e => console.error(e.message));
