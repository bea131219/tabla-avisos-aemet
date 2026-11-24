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
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloResumen = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloResumen.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });

    const tablaResumen = page.locator('table').filter({ hasText: '00' }).filter({ hasText: '23' }).filter({ hasText: /lunes|martes|miércoles|jueves|viernes|sábado|domingo/i }).last();
    const tablaDetalle = page.locator('table').filter({ hasText: 'Fenómenos previstos' }).filter({ hasText: 'Nivel de aviso' }).filter({ hasText: 'Zona de avisos' }).filter({ hasText: 'Comentario' }).last();

    await tablaResumen.waitFor({ state: 'visible', timeout: 30000 });
    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Forzar renderizado completo de la tabla de detalle y esperar estabilidad.
    let f0 = -1, h0 = -1, estable = 0;
    for (let i = 0; i < 15 && estable < 3; i++) {
      const filas = tablaDetalle.locator('tr');
      const n = await filas.count();
      if (n) await filas.nth(n - 1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b = await tablaDetalle.boundingBox();
      const h = b ? Math.round(b.height) : -1;
      if (n === f0 && h === h0) estable++; else estable = 0;
      f0 = n; h0 = h;
    }

    // Esperar iconos de ambos bloques.
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    // Captura 1: resumen "Avisos meteorológicos", incluido su título.
    const resumenClip = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const els = Array.from(document.querySelectorAll('body *'));
      const titulo = els.find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(el.textContent) === 'Avisos meteorológicos';
      });
      const tablas = Array.from(document.querySelectorAll('table')).filter(t => {
        const tx = norm(t.innerText); const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /\b00\b/.test(tx) && /\b23\b/.test(tx) && /(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/i.test(tx);
      });
      if (!titulo || !tablas.length) throw new Error('No se encontro el resumen Avisos meteorologicos.');
      const tabla = tablas[tablas.length - 1];
      const a = titulo.getBoundingClientRect(), b = tabla.getBoundingClientRect();
      const x = Math.max(0, Math.floor(Math.min(a.left,b.left) + window.scrollX - 8));
      const y = Math.max(0, Math.floor(a.top + window.scrollY - 8));
      const right = Math.ceil(Math.max(a.right,b.right) + window.scrollX + 8);
      const bottom = Math.ceil(b.bottom + window.scrollY + 8);
      return { x, y, width: right-x, height: bottom-y };
    });

    const fecha = fechaManana();
    const resumen = 'docs/aemet-avisos-resumen-manana.png';
    const detalle = 'docs/aemet-tabla-manana.png';

    await page.screenshot({ path: resumen, type: 'png', clip: resumenClip, animations: 'disabled' });

    // Captura 2: tabla de detalle COMPLETA. Screenshot directo del elemento evita cortes por altura.
    const filasFinales = await tablaDetalle.locator('tr').count();
    const boxDetalle = await tablaDetalle.boundingBox();
    if (!boxDetalle) throw new Error('No se obtuvieron dimensiones de Detalle de avisos.');
    await tablaDetalle.screenshot({ path: detalle, type: 'png', animations: 'disabled' });

    fs.copyFileSync(resumen, `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(detalle, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${resumen}`);
    console.log(`Detalle generado: ${detalle}`);
    console.log(`Filas detalle detectadas: ${filasFinales}`);
    console.log(`Altura detalle: ${Math.round(boxDetalle.height)} px`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
