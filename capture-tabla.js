const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")', 'a:has-text("Aceptar cookies")', 'text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({ timeout: 2000 }); return; } catch {}
  }
}

function estadoAvisos(texto) {
  const cabeceras = texto.includes('Fenómenos previstos') && texto.includes('Nivel de aviso') && texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cabeceras && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async () => {
  let browser;
  try {
    fs.mkdirSync('docs/archive', { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloAvisos = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloAvisos.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // AEMET puede cargar el detalle al desplazarse. Forzamos su renderizado.
    await tituloDetalle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);

    await page.getByText('Fenómenos previstos', { exact: true }).last()
      .waitFor({ state: 'visible', timeout: 30000 });

    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    const limites = await page.evaluate(() => {
      const limpio = v => (v || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const inicio = visibles.find(el => limpio(el.textContent) === 'Avisos meteorológicos');
      const detalle = visibles.find(el => limpio(el.textContent) === 'Detalle de avisos');
      if (!inicio || !detalle) throw new Error('No se localizaron los bloques de AEMET.');

      const yDetalle = detalle.getBoundingClientRect().top + window.scrollY;
      const tablas = Array.from(document.querySelectorAll('table')).filter(el => {
        const r = el.getBoundingClientRect();
        const t = limpio(el.innerText);
        return r.width > 0 && r.height > 0 && r.top + window.scrollY >= yDetalle - 20 &&
          t.includes('Fenómenos previstos') && t.includes('Nivel de aviso') && t.includes('Zona de avisos');
      });

      // Si AEMET cambia la estructura, el respaldo llega hasta el final de la página.
      const fin = tablas.length
        ? Math.max(...tablas.map(el => el.getBoundingClientRect().bottom + window.scrollY))
        : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

      return {
        y: inicio.getBoundingClientRect().top + window.scrollY,
        fin,
        ancho: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
        alto: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      };
    });

    const x = 35;
    const y = Math.max(0, Math.floor(limites.y - 12));
    const derecha = Math.min(limites.ancho - 10, 1390);
    const abajo = Math.min(limites.alto, Math.ceil(limites.fin + 20));
    const clip = { x, y, width: derecha - x, height: abajo - y };

    if (clip.width <= 0 || clip.height <= 0) throw new Error(`Recorte inválido: ${JSON.stringify(clip)}`);
    console.log('Recorte aplicado:', clip);

    const fecha = fechaManana();
    const png = 'docs/aemet-tabla-manana.png';
    await page.screenshot({ path: png, type: 'png', clip });
    fs.copyFileSync(png, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Captura generada: ${png}`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();

