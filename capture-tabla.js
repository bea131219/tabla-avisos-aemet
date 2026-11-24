const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.aemet.es/es/eltiempo/prediccion/avisos?datos=img&f=AT&w=mna';

function fechaManana() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function aceptarCookies(page) {
  for (const s of ['button:has-text("Aceptar cookies")','a:has-text("Aceptar cookies")','text="Aceptar cookies"']) {
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

    const tablaDetalle = page.locator('table').filter({ hasText: 'Fenómenos previstos' }).filter({ hasText: 'Nivel de aviso' }).filter({ hasText: 'Zona de avisos' }).filter({ hasText: 'Comentario' }).last();
    await tablaDetalle.waitFor({ state: 'visible', timeout: 30000 });

    let f0=-1,h0=-1,estable=0;
    for(let i=0;i<15 && estable<3;i++){
      const filas=tablaDetalle.locator('tr'); const n=await filas.count();
      if(n) await filas.nth(n-1).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const b=await tablaDetalle.boundingBox(); const h=b?Math.round(b.height):-1;
      if(n===f0 && h===h0) estable++; else estable=0; f0=n; h0=h;
    }

    await page.evaluate(async()=>{await Promise.all(Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(r=>{img.addEventListener('load',r,{once:true});img.addEventListener('error',r,{once:true});})));});

    const fecha=fechaManana();
    const pngResumen='docs/aemet-avisos-resumen-manana.png';
    const pngDetalle='docs/aemet-tabla-manana.png';

    // Localizar el CONTENEDOR del resumen por el titulo y por rasgos visuales de la matriz.
    const resumen = await page.evaluateHandle(() => {
      const norm=v=>(v||'').replace(/\s+/g,' ').trim();
      const titles=Array.from(document.querySelectorAll('body *')).filter(el=>{
        const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && norm(el.textContent)==='Avisos meteorológicos';
      });
      const title=titles[titles.length-1];
      if(!title) throw new Error('No se encontro Avisos meteorológicos');
      let n=title.parentElement;
      while(n && n!==document.body){
        const text=norm(n.innerText); const r=n.getBoundingClientRect();
        const colored=Array.from(n.querySelectorAll('*')).filter(el=>{
          const s=getComputedStyle(el); const c=s.backgroundColor; const q=el.getBoundingClientRect();
          return q.width>=8 && q.width<=50 && q.height>=8 && q.height<=50 && c && c!=='rgba(0, 0, 0, 0)' && c!=='rgb(255, 255, 255)';
        }).length;
        if(r.width>700 && r.height>150 && r.height<700 && colored>20 && !text.includes('Detalle de avisos')) return n;
        n=n.parentElement;
      }
      return null;
    });

    const resumenEl = resumen.asElement();
    if (!resumenEl) throw new Error('No se encontro el contenedor completo de Avisos meteorológicos.');
    await resumenEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await resumenEl.screenshot({ path: pngResumen, type:'png', animations:'disabled' });

    // Detalle completo, metodo que ya funciona.
    await tablaDetalle.screenshot({ path: pngDetalle, type:'png', animations:'disabled' });

    fs.copyFileSync(pngResumen, `docs/archive/aemet-avisos-resumen-manana-${fecha}.png`);
    fs.copyFileSync(pngDetalle, `docs/archive/aemet-tabla-manana-${fecha}.png`);
    const estado=estadoAvisos(await page.locator('body').innerText());
    fs.writeFileSync('docs/estado-avisos.txt',`${estado}\n`,'utf8');
    fs.writeFileSync(`docs/archive/estado-avisos-${fecha}.txt`,`${estado}\n`,'utf8');
    console.log(`Resumen generado: ${pngResumen}`);
    console.log(`Detalle completo generado: ${pngDetalle}`);
    console.log(`Estado: ${estado}`);
  } catch(e) {
    console.error('Error en capture-tabla.js:',e); process.exitCode=1;
  } finally { if(browser) await browser.close(); }
})();
