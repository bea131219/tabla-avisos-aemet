const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")','a:has-text("Aceptar cookies")','text="Aceptar cookies"']) {
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

    // Recorremos toda la pagina para forzar la carga/renderizado de TODAS las filas.
    await page.evaluate(async () => {
      const paso = 700;
      for (let y = 0; y < document.documentElement.scrollHeight; y += paso) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 250));
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(r => setTimeout(r, 1200));
    });

    await page.getByText('Fenómenos previstos', { exact: true }).last().waitFor({ state: 'visible', timeout: 30000 });

    // Esperar imagenes/iconos.
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    const limites = await page.evaluate(() => {
      const limpio = v => (v || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const inicio = visibles.find(el => limpio(el.textContent) === 'Avisos meteorológicos');
      const detalle = visibles.find(el => limpio(el.textContent) === 'Detalle de avisos');
      if (!inicio || !detalle) throw new Error('No se localizaron Avisos meteorológicos / Detalle de avisos.');

      const yInicio = inicio.getBoundingClientRect().top + window.scrollY;
      const yDetalle = detalle.getBoundingClientRect().top + window.scrollY;

      // Identificar la tabla de Detalle y usar el fondo REAL de todas sus filas.
      const candidatas = Array.from(document.querySelectorAll('table')).filter(t => {
        const txt = limpio(t.innerText);
        const r = t.getBoundingClientRect();
        const top = r.top + window.scrollY;
        return r.width > 0 && r.height > 0 && top >= yDetalle - 30 &&
          txt.includes('Fenómenos previstos') && txt.includes('Nivel de aviso') &&
          txt.includes('Zona de avisos') && txt.includes('Comentario');
      });

      if (!candidatas.length) throw new Error('No se encontro la tabla completa de Detalle de avisos.');

      // Elegimos la candidata que llega mas abajo, evitando quedarnos con un contenedor parcial.
      const tabla = candidatas.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      const filas = Array.from(tabla.querySelectorAll('tr'));
      let fin = tabla.getBoundingClientRect().bottom + window.scrollY;
      if (filas.length) {
        fin = Math.max(fin, ...filas.map(f => f.getBoundingClientRect().bottom + window.scrollY));
      }

      const docW = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
      const docH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      return { yInicio, fin, docW, docH, filas: filas.length };
    });

    const x = 35;
    const y = Math.max(0, Math.floor(limites.yInicio - 12));
    const derecha = Math.min(limites.docW - 10, 1390);
    // No recortar el fondo al viewport: clip usa coordenadas del documento completo.
    const abajo = Math.min(limites.docH, Math.ceil(limites.fin + 30));
    const clip = { x, y, width: derecha - x, height: abajo - y };

    if (clip.width <= 0 || clip.height <= 0) throw new Error(`Recorte invalido: ${JSON.stringify(clip)}`);
    console.log(`Filas de Detalle detectadas: ${limites.filas}`);
    console.log('Recorte completo:', clip);

    const fecha = fechaManana();
    const png = 'docs/aemet-tabla-manana.png';
    await page.screenshot({ path: png, type: 'png', clip, animations: 'disabled' });
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
