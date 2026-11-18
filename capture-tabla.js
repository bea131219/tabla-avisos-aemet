const { chromium } = require('playwright');
const fs = require('fs');

function getTomorrowStampMadrid() {
  const madridToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const [year, month, day] = madridToday.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return `${tomorrow.getUTCFullYear()}${String(tomorrow.getUTCMonth()+1).padStart(2,'0')}${String(tomorrow.getUTCDate()).padStart(2,'0')}`;
}

async function acceptCookies(page) {
  for (const selector of [
    'button:has-text("Aceptar cookies")',
    'a:has-text("Aceptar cookies")',
    'input[value*="Aceptar cookies"]',
    'text="Aceptar cookies"'
  ]) {
    try {
      await page.locator(selector).first().click({ timeout: 2500 });
      return;
    } catch {}
  }
}

async function findAvisosMeteorologicosBlock(page) {
  // No usamos "following::table[1]": ese selector puede saltar a "Detalle de avisos".
  // Localizamos una tabla por sus rasgos exclusivos: comunidades + escala horaria 00..23.
  const tables = page.locator('table');
  const total = await tables.count();

  for (let i = 0; i < total; i++) {
    const table = tables.nth(i);
    const text = (await table.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

    const hasRegions =
      text.includes('Andalucía') &&
      text.includes('Cantabria') &&
      (text.includes('Principado de Asturias') || text.includes('País Vasco'));

    const hasHourlyScale =
      /(^|\s)00(\s|$)/.test(text) &&
      /(^|\s)01(\s|$)/.test(text) &&
      /(^|\s)22(\s|$)/.test(text) &&
      /(^|\s)23(\s|$)/.test(text);

    const isDetailTable =
      text.includes('Fenómenos previstos') ||
      text.includes('Nivel de aviso') ||
      text.includes('Probabilidad') ||
      text.includes('Hora de comienzo') ||
      text.includes('Hora de finalización');

    if (hasRegions && hasHourlyScale && !isDetailTable) {
      // Si el titulo esta en un contenedor padre, capturamos el bloque completo
      // para incluir "Avisos meteorológicos", la tabla y la franja azul del dia.
      const parentCandidates = [
        table.locator('xpath=..'),
        table.locator('xpath=../..'),
        table.locator('xpath=../../..')
      ];

      for (const candidate of parentCandidates) {
        const candidateText = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ');
        if (candidateText.includes('Avisos meteorológicos') && !candidateText.includes('Detalle de avisos')) {
          return candidate;
        }
      }

      return table;
    }
  }

  throw new Error('No se encontro la tabla horaria de Avisos meteorológicos (00-23).');
}

(async () => {
  let browser;
  try {
    fs.mkdirSync('docs/archive', { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });

    await page.goto('https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna', {
      waitUntil: 'domcontentloaded', timeout: 90000
    });

    await acceptCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const block = await findAvisosMeteorologicosBlock(page);
    await block.waitFor({ state: 'visible', timeout: 60000 });
    await block.scrollIntoViewIfNeeded();

    await block.evaluate(async (element) => {
      const images = Array.from(element.querySelectorAll('img'));
      await Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    await page.waitForTimeout(750);

    const latestFile = 'docs/aemet-tabla-manana.png';
    const archiveFile = `docs/archive/aemet-tabla-manana-${getTomorrowStampMadrid()}.png`;

    await block.screenshot({ path: latestFile, type: 'png' });
    fs.copyFileSync(latestFile, archiveFile);

    console.log(`Tabla de Avisos meteorológicos guardada: ${latestFile}`);
    console.log(`Copia historica guardada: ${archiveFile}`);
  } catch (error) {
    console.error('Error durante la captura:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
