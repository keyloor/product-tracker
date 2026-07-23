// Tracker de productos nuevos de Pokémon en varias tiendas.
//
// Cada tienda tiene un adaptador (adapters/) que sabe cómo listar sus productos
// publicados. El orquestador compara contra el estado, filtra lo que es de
// Pokémon y envía un solo correo con todo lo nuevo.
//
// Toda la configuración viene por entorno: el repositorio no contiene datos de
// las tiendas ni direcciones de correo.
//
// Sin dependencias: usa fetch nativo de Node 18+.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { crearAdaptadorEcwid } from "./adapters/ecwid.js";
import { crearAdaptadorWix } from "./adapters/wix.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO;
const MAIL_FROM = process.env.MAIL_FROM || "Alertas <onboarding@resend.dev>";
const STATE_FILE = process.env.STATE_FILE || "state/seen.json";

// Las tiendas se definen por entorno para no dejarlas escritas en el repo.
function construirTiendas() {
  const tiendas = [];

  if (process.env.ECWID_STORE_ID && process.env.ECWID_PUBLIC_TOKEN) {
    tiendas.push(
      crearAdaptadorEcwid({
        storeId: process.env.ECWID_STORE_ID,
        token: process.env.ECWID_PUBLIC_TOKEN,
        nombre: process.env.ECWID_STORE_NAME || "Tienda 1",
        clave: "ecwid",
      }),
    );
  }
  if (process.env.WIX_BASE_URL) {
    tiendas.push(
      crearAdaptadorWix({
        baseUrl: process.env.WIX_BASE_URL.replace(/\/+$/, ""),
        nombre: process.env.WIX_STORE_NAME || "Tienda 2",
        clave: "wix",
      }),
    );
  }
  return tiendas;
}

// ---- Estado: un conjunto de ids por tienda ----
async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null; // primera corrida
    throw err;
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildEmail(porTienda, total) {
  const plural = total === 1 ? "producto nuevo" : "productos nuevos";
  const subject = `⚡ ${total} ${plural} de Pokémon`;

  const secciones = porTienda
    .map(({ tienda, productos }) => {
      const filas = productos
        .map((p) => {
          const img = p.imageUrl
            ? `<img src="${escapeHtml(p.imageUrl)}" alt="" width="80" height="80" style="border-radius:8px;object-fit:cover;display:block">`
            : "";
          const precio = p.defaultDisplayedPriceFormatted
            ? `<div style="color:#111;font-weight:600;margin-top:4px">${escapeHtml(p.defaultDisplayedPriceFormatted)}</div>`
            : "";
          const aviso =
            p.clase === "dudoso"
              ? `<div style="color:#b26a00;font-size:12px;margin-top:4px">⚠️ No se pudo confirmar que sea de Pokémon</div>`
              : "";
          return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #eee;vertical-align:top;width:92px">${img}</td>
        <td style="padding:12px 0 12px 14px;border-bottom:1px solid #eee;vertical-align:top">
          <a href="${escapeHtml(p.url)}" style="color:#0a58ca;font-size:16px;font-weight:600;text-decoration:none">${escapeHtml(p.name || "(sin nombre)")}</a>
          ${precio}
          ${aviso}
        </td>
      </tr>`;
        })
        .join("");

      return `
      <h3 style="margin:22px 0 2px;font-size:15px;color:#444">${escapeHtml(tienda)}</h3>
      <table style="width:100%;border-collapse:collapse">${filas}</table>`;
    })
    .join("");

  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="margin:0 0 4px">Nuevos productos de Pokémon</h2>
    <p style="color:#666;margin:0 0 6px">Se detectaron <b>${total}</b> ${plural}.</p>
    ${secciones}
    <p style="color:#aaa;font-size:12px;margin-top:20px">Notificación automática</p>
  </div>`;

  const text = porTienda
    .map(
      ({ tienda, productos }) =>
        `== ${tienda} ==\n` +
        productos
          .map(
            (p) =>
              `• ${p.name}${p.clase === "dudoso" ? " [revisar]" : ""} — ${p.defaultDisplayedPriceFormatted || ""}\n  ${p.url}`,
          )
          .join("\n\n"),
    )
    .join("\n\n");

  return { subject, html, text };
}

async function sendEmail({ subject, html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, html, text }),
  });
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function enviarAviso(asunto, cuerpo) {
  await sendEmail({
    subject: asunto,
    html: `<p style="font-family:system-ui,Arial,sans-serif">${escapeHtml(cuerpo)}</p>`,
    text: cuerpo,
  });
}

// ---- Flujo principal ----
async function main() {
  if (!RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY en el entorno.");
  if (!MAIL_TO) throw new Error("Falta MAIL_TO en el entorno.");

  const tiendas = construirTiendas();
  if (tiendas.length === 0) {
    throw new Error("No hay tiendas configuradas (revisa las variables de entorno).");
  }

  const stateAnterior = await loadState();
  const primeraCorrida = stateAnterior === null;
  const state = stateAnterior ?? { tiendas: {} };
  state.tiendas ??= {};

  const porTienda = [];
  const fallos = [];
  let cambioEstado = false;

  for (const tienda of tiendas) {
    // Cada tienda va aislada: si una falla, las demás siguen.
    try {
      const publicados = await tienda.listarPublicados();
      const idsActuales = publicados.map((p) => String(p.id));
      console.log(`${tienda.clave}: ${publicados.length} productos publicados.`);

      const previo = state.tiendas[tienda.clave];

      // Primera vez que se ve esta tienda: registrar sin notificar.
      if (!previo) {
        state.tiendas[tienda.clave] = { ids: idsActuales.sort() };
        cambioEstado = true;
        console.log(`${tienda.clave}: estado inicial guardado, sin notificar.`);
        continue;
      }

      const vistos = new Set(previo.ids || []);
      const nuevos = publicados.filter((p) => !vistos.has(String(p.id)));

      if (nuevos.length === 0) continue;

      // Solo se descarga el detalle de los nuevos, que son pocos.
      const detallados = await tienda.detallar(nuevos);
      const interesantes = detallados.filter(
        (p) => p.clase === "pokemon" || p.clase === "dudoso",
      );

      if (interesantes.length > 0) {
        porTienda.push({ tienda: tienda.nombre, productos: interesantes });
      }

      // Los ids solo se agregan, nunca se quitan.
      state.tiendas[tienda.clave] = {
        ids: [...new Set([...vistos, ...idsActuales])].sort(),
      };
      cambioEstado = true;
      console.log(
        `${tienda.clave}: ${nuevos.length} nuevos, ${interesantes.length} de interés.`,
      );
    } catch (err) {
      console.error(`${tienda.clave}: FALLÓ -> ${err.message}`);
      fallos.push(`${tienda.clave}: ${err.message}`);
    }
  }

  const total = porTienda.reduce((n, t) => n + t.productos.length, 0);

  if (total > 0) {
    await sendEmail(buildEmail(porTienda, total));
    console.log(`Email enviado con ${total} producto(s).`);
  } else if (!primeraCorrida) {
    console.log("Sin novedades de Pokémon.");
  }

  // Un adaptador roto (típico en Wix) no puede quedarse callado.
  if (fallos.length > 0) {
    try {
      await enviarAviso(
        "⚠️ El tracker falló en una tienda",
        `No se pudo revisar:\n\n${fallos.join("\n")}`,
      );
    } catch (err) {
      console.error("Además falló el aviso por correo:", err.message);
    }
  }

  if (cambioEstado) await saveState(state);

  // Si TODAS las tiendas fallaron, la corrida se marca como fallida.
  if (fallos.length === tiendas.length) process.exit(1);
}

main().catch((err) => {
  console.error("Error en el tracker:", err.message);
  process.exit(1);
});
