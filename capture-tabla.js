const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")', 'a:has-text("Aceptar cookies")', 'text="Aceptar cookies"']) {
    try { await page.locator(s).first().click({ timeout: 2000 }); return; } catch {}
  }
}

function estadoAvisos(texto) {
  const cab = texto.includes('Fenómenos previstos') && texto.includes('Nivel de aviso') && texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cab && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
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

    const tablaDetalle = page.locator('table')
      .filter({ hasText: 'Fenómenos previstos' })
      .filter({ hasText: 'Nivel de aviso' })
      .filter({ hasText: 'Zona de avisos' })
      .filter({ hasText: 'Comentario' })
      .last();
    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Esperar a que la tabla de detalle se estabilice y cargue todas sus filas.
    let f0 = -1, h0 = -1, estable = 0;
    for (let i = 0; i < 15 && estable < 3; i++) {
      const filas = tablaDetalle.locator('tr');
      const n = await filas.count();
      if (n) await filas.nth(n - 1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b = await tablaDetalle.boundingBox();
      const h = b ? Math.round(b.height) : -1;
      if (n === f0 && h === h0) estable++; else estable = 0;
      f0 = n;
      h0 = h;
    }

    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(r => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      })));
    });

    const fecha = fechaManana();
    const pngResumen = 'docs/aemet-avisos-resumen-manana.png';
    const pngDetalle = 'docs/aemet-tabla-manana.png';

    // RESUMEN ROBUSTO: no depende del numero de comunidades, colores o altura del dia.
    // Se captura desde el titulo "Avisos meteorológicos" hasta justo antes de "Detalle de avisos".
    await tituloResumen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const resumenClip = await page.evaluate(() => {
      const norm = v => (v || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      });

      const resumenes = visibles.filter(el => norm(el.textContent) === 'Avisos meteorológicos');
      const detalles = visibles.filter(el => norm(el.textContent) === 'Detalle de avisos');
      if (!resumenes.length || !detalles.length) {
        throw new Error('No se encontraron los titulos Avisos meteorológicos / Detalle de avisos.');
      }

      // Usar el ultimo titulo de resumen que tenga un Detalle de avisos por debajo.
      let resumen = null;
      let detalle = null;
      for (let i = resumenes.length - 1; i >= 0; i--) {
        const r = resumenes[i].getBoundingClientRect();
        const y = r.top + window.scrollY;
        const posteriores = detalles
          .map(el => ({ el, y: el.getBoundingClientRect().top + window.scrollY }))
          .filter(x => x.y > y)
          .sort((a, b) => a.y - b.y);
        if (posteriores.length) {
          resumen = resumenes[i];
          detalle = posteriores[0].el;
          break;
        }
      }
      if (!resumen || !detalle) throw new Error('No se pudo delimitar el resumen de avisos.');

      const rr = resumen.getBoundingClientRect();
      const rd = detalle.getBoundingClientRect();
      const top = rr.top + window.scrollY;
      const bottomLimit = rd.top + window.scrollY;

      // Elementos visibles que comienzan despues del titulo y terminan antes del detalle.
      // Se excluyen contenedores gigantes que engloban mapa + resumen + detalle.
      const bloque = visibles.filter(el => {
        const r = el.getBoundingClientRect();
        const t = r.top + window.scrollY;
        const b = r.bottom + window.scrollY;
        return t >= top - 5 && b <= bottomLimit - 8 && r.width >= 10 && r.height >= 5 && r.height < (bottomLimit - top + 30);
      });

      if (!bloque.length) throw new Error('No se encontraron elementos dentro del resumen de avisos.');

      // El limite superior se fija exactamente en el titulo para no incluir el mapa.
      // El inferior es el ultimo elemento visible antes de Detalle de avisos.
      let left = rr.left + window.scrollX;
      let right = rr.right + window.scrollX;
      let bottom = rr.bottom + window.scrollY;

      for (const el of bloque) {
        const r = el.getBoundingClientRect();
        // Ignorar elementos a ancho completo de pagina que pertenecen a contenedores generales.
        if (r.width > 1500) continue;
        left = Math.min(left, r.left + window.scrollX);
        right = Math.max(right, r.right + window.scrollX);
        bottom = Math.max(bottom, r.bottom + window.scrollY);
      }

      // Margenes pequenos. El fondo nunca puede alcanzar el titulo "Detalle de avisos".
      const x = Math.max(0, Math.floor(left - 6));
      const y = Math.max(0, Math.floor(top - 6));
      const finalRight = Math.ceil(right + 6);
      const finalBottom = Math.min(Math.ceil(bottom + 6), Math.floor(bottomLimit - 8));

      return { x, y, width: finalRight - x, height: finalBottom - y };
    });

    if (resumenClip.width <= 0 || resumenClip.height <= 0) {
      throw new Error(`Recorte de Avisos meteorológicos invalido: ${JSON.stringify(resumenClip)}`);
    }

    console.log('Recorte Avisos meteorológicos:', resumenClip);
    await page.screenshot({ path: pngResumen, type: 'png', clip: resumenClip, animations: 'disabled' });

    // DETALLE COMPLETO: mantener screenshot directo del elemento TABLE.
    await tablaDetalle.screenshot({ path: pngDetalle, type: 'png', animations: 'disabled' });

    fs.copyFileSync(pngResumen, `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(pngDetalle, `docs/archive/aemet-tabla-manana-${fecha}.png`);

    const estado = estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Detalle completo generado: ${pngDetalle}`);
    console.log(`Estado: ${estado}`);
  } catch (e) {
    console.error('Error en capture-tabla.js:', e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
