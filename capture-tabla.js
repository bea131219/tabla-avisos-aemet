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
  for (const selector of [
    'button:has-text("Aceptar cookies")',
    'a:has-text("Aceptar cookies")',
    'text="Aceptar cookies"'
  ]) {
    try {
      await page.locator(selector).first().click({ timeout: 2000 });
      return;
    } catch {}
  }
}

function estadoAvisos(texto) {
  const cabeceras = texto.includes('Fenómenos previstos') &&
    texto.includes('Nivel de aviso') &&
    texto.includes('Zona de avisos');
  const nivel = /Peligro\s+(bajo|importante|extraordinario)/i.test(texto);
  return cabeceras && nivel ? 'CON_AVISOS' : 'SIN_AVISOS';
}

(async () => {
  let browser;

  try {
    fs.mkdirSync('docs/archive', { recursive: true });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1
    });

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    await aceptarCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const tituloResumen = page.getByText('Avisos meteorológicos', { exact: true }).last();
    const tituloDetalle = page.getByText('Detalle de avisos', { exact: true }).last();
    await tituloResumen.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.waitFor({ state: 'visible', timeout: 30000 });
    await tituloDetalle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);

    // Localizar SOLO la tabla real de Detalle de avisos.
    const tablaDetalle = page.locator('table').filter({
      hasText: 'Fenómenos previstos'
    }).filter({
      hasText: 'Nivel de aviso'
    }).filter({
      hasText: 'Zona de avisos'
    }).filter({
      hasText: 'Comentario'
    }).last();

    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    // Esperar a que AEMET haya incorporado todas las filas. Se considera estable
    // cuando el numero de filas y la altura dejan de cambiar en varias comprobaciones.
    let anteriorFilas = -1;
    let anteriorAlto = -1;
    let estable = 0;

    for (let intento = 0; intento < 15 && estable < 3; intento++) {
      const filas = tablaDetalle.locator('tr');
      const total = await filas.count();

      if (total > 0) {
        await filas.nth(total - 1).scrollIntoViewIfNeeded();
      }

      await page.waitForTimeout(700);

      const box = await tablaDetalle.boundingBox();
      const alto = box ? Math.round(box.height) : -1;

      if (total === anteriorFilas && alto === anteriorAlto) {
        estable++;
      } else {
        estable = 0;
      }

      anteriorFilas = total;
      anteriorAlto = alto;
    }

    // Esperar los iconos de fenomenos contenidos en la tabla.
    await tablaDetalle.evaluate(async (tabla) => {
      const imagenes = Array.from(tabla.querySelectorAll('img'));
      await Promise.all(imagenes.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
    });

    const filasFinales = await tablaDetalle.locator('tr').count();
    const boxFinal = await tablaDetalle.boundingBox();

    if (!boxFinal || boxFinal.width <= 0 || boxFinal.height <= 0) {
      throw new Error('No se pudieron obtener las dimensiones finales de la tabla Detalle de avisos.');
    }

    console.log(`Filas finales detectadas: ${filasFinales}`);
    console.log(`Tamano final tabla: ${Math.round(boxFinal.width)} x ${Math.round(boxFinal.height)} px`);

    const fecha = fechaManana();
    const pngResumen = 'docs/aemet-avisos-resumen-manana.png';
    const png = 'docs/aemet-tabla-manana.png';
    const historicoResumen = `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`;
    const historicoPng = `docs/archive/aemet-tabla-manana-${fecha}.png`;

    // RESUMEN: capturar SOLO el titulo "Avisos meteorológicos" y su matriz.
    // No usamos un recorte entre secciones porque incluiria partes del mapa o del detalle.
    const resumenClip = await page.evaluate(() => {
      const norm = v => (v || '').replace(/\s+/g, ' ').trim();
      const visibles = Array.from(document.querySelectorAll('body *')).filter(el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
      });

      const titulos = visibles.filter(el => norm(el.textContent) === 'Avisos meteorológicos');
      if (!titulos.length) throw new Error('No se encontro el titulo Avisos meteorológicos.');

      // Preferir el titulo situado inmediatamente antes de la matriz de colores.
      const titulo = titulos[titulos.length - 1];
      const rt = titulo.getBoundingClientRect();
      const tituloTop = rt.top + window.scrollY;
      const tituloBottom = rt.bottom + window.scrollY;

      // Buscar el contenedor mas pequeno que incluya el titulo y el contenido del resumen,
      // pero que NO incluya "Detalle de avisos" ni contenido anterior del mapa.
      const candidatos = [];
      let nodo = titulo.parentElement;
      while (nodo && nodo !== document.body) {
        const r = nodo.getBoundingClientRect();
        const texto = norm(nodo.innerText);
        const top = r.top + window.scrollY;
        const bottom = r.bottom + window.scrollY;
        if (r.width > 400 && r.height > 150 && top <= tituloTop && bottom > tituloBottom &&
            !texto.includes('Detalle de avisos')) {
          candidatos.push({ nodo, area: r.width * r.height, top, bottom, left: r.left + window.scrollX, right: r.right + window.scrollX });
        }
        nodo = nodo.parentElement;
      }

      // Si no hay un padre util, delimitamos por elementos que visualmente pertenecen al resumen:
      // desde el titulo hasta la barra azul/horas, sin llegar a "Detalle de avisos".
      if (!candidatos.length) {
        const detalle = visibles.find(el => norm(el.textContent) === 'Detalle de avisos');
        if (!detalle) throw new Error('No se pudo delimitar Avisos meteorológicos.');
        const rd = detalle.getBoundingClientRect();
        const limite = rd.top + window.scrollY;
        const zona = visibles.filter(el => {
          const r = el.getBoundingClientRect();
          const top = r.top + window.scrollY;
          const bottom = r.bottom + window.scrollY;
          return top >= tituloTop - 5 && bottom < limite - 20 && r.width > 5 && r.height > 5;
        });
        const left = Math.min(rt.left + window.scrollX, ...zona.map(el => el.getBoundingClientRect().left + window.scrollX));
        const right = Math.max(rt.right + window.scrollX, ...zona.map(el => el.getBoundingClientRect().right + window.scrollX));
        const bottom = Math.max(rt.bottom + window.scrollY, ...zona.map(el => el.getBoundingClientRect().bottom + window.scrollY));
        return { x: Math.max(0, Math.floor(left - 6)), y: Math.max(0, Math.floor(tituloTop - 6)), width: Math.ceil(right - left + 12), height: Math.ceil(bottom - tituloTop + 12) };
      }

      candidatos.sort((a,b) => a.area - b.area);
      const c = candidatos[0];
      // La parte superior se fuerza al titulo: asi nunca entra el mapa.
      return {
        x: Math.max(0, Math.floor(c.left - 6)),
        y: Math.max(0, Math.floor(tituloTop - 6)),
        width: Math.ceil(c.right - c.left + 12),
        height: Math.ceil(c.bottom - tituloTop + 12)
      };
    });

    if (resumenClip.width <= 0 || resumenClip.height <= 0) {
      throw new Error(`Recorte del resumen invalido: ${JSON.stringify(resumenClip)}`);
    }

    await tituloResumen.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    console.log('Recorte solo Avisos meteorológicos:', resumenClip);
    await page.screenshot({ path: pngResumen, type: 'png', clip: resumenClip, animations: 'disabled' });

    // DETALLE: mantenemos exactamente el metodo que ya funciona: captura del elemento TABLE completo.
    await tablaDetalle.screenshot({ path: png, type: 'png', animations: 'disabled' });

    fs.copyFileSync(pngResumen, historicoResumen);
    fs.copyFileSync(png, historicoPng);

    const textoPagina = await page.locator('body').innerText();
    const estado = estadoAvisos(textoPagina);
    fs.writeFileSync('docs/estado-avisos.txt', `${estado}\n`, 'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`, `${estado}\n`, 'utf8');

    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Captura completa generada: ${png}`);
    console.log(`Historico: ${historicoPng}`);
    console.log(`Estado: ${estado}`);

  } catch (error) {
    console.error('Error en capture-tabla.js:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
