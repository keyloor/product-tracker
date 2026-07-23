// Tracker de productos nuevos para una tienda Ecwid.
// Consulta la API pública de Ecwid, detecta productos nuevos comparando contra
// un archivo de estado (state/seen.json) y envía un email con Resend.
//
// Toda la configuración viene por variables de entorno: el repositorio no
// contiene datos de la tienda ni direcciones de correo.
//
// Sin dependencias: usa fetch nativo de Node 18+.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ---- Configuración (toda por entorno; ver .env.example) ----
const STORE_ID = process.env.ECWID_STORE_ID;
const ECWID_TOKEN = process.env.ECWID_PUBLIC_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO;
const MAIL_FROM = process.env.MAIL_FROM || "Alertas <onboarding@resend.dev>";
const STATE_FILE = process.env.STATE_FILE || "state/seen.json";
const STORE_NAME = process.env.STORE_NAME || "la tienda";

const API_BASE = `https://app.ecwid.com/api/v3/${STORE_ID}/products`;

// ---- Utilidades ----
async function loadSeen() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return new Set(data.ids || []);
  } catch (err) {
    if (err.code === "ENOENT") return null; // primera corrida
    throw err;
  }
}

async function saveSeen(idSet) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    count: idSet.size,
    ids: [...idSet].sort((a, b) => a - b),
  };
  await writeFile(STATE_FILE, JSON.stringify(payload, null, 2) + "\n");
}

// Trae TODOS los productos del catálogo (paginado).
async function fetchAllProducts() {
  const products = [];
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url =
      `${API_BASE}?token=${ECWID_TOKEN}` +
      `&sortBy=ADDED_TIME_DESC&limit=${limit}&offset=${offset}` +
      `&responseFields=total,count,items(id,name,enabled,created,url,imageUrl,defaultDisplayedPriceFormatted)`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Ecwid API respondió ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    total = data.total ?? products.length;
    products.push(...(data.items || []));
    if (!data.items || data.items.length === 0) break;
    offset += limit;
  }
  return products;
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildEmail(newProducts) {
  const plural = newProducts.length === 1 ? "producto nuevo" : "productos nuevos";
  const subject = `🃏 ${newProducts.length} ${plural} en ${STORE_NAME}`;

  const cards = newProducts
    .map((p) => {
      const img = p.imageUrl
        ? `<img src="${escapeHtml(p.imageUrl)}" alt="" width="90" height="90" style="border-radius:8px;object-fit:cover;display:block">`
        : "";
      const price = p.defaultDisplayedPriceFormatted
        ? `<div style="color:#111;font-weight:600;margin-top:4px">${escapeHtml(p.defaultDisplayedPriceFormatted)}</div>`
        : "";
      return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #eee;vertical-align:top;width:100px">${img}</td>
        <td style="padding:12px 0 12px 14px;border-bottom:1px solid #eee;vertical-align:top">
          <a href="${escapeHtml(p.url)}" style="color:#0a58ca;font-size:16px;font-weight:600;text-decoration:none">${escapeHtml(p.name || "(sin nombre)")}</a>
          ${price}
          <div style="color:#888;font-size:12px;margin-top:4px">Agregado: ${escapeHtml(p.created || "—")}</div>
        </td>
      </tr>`;
    })
    .join("");

  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="margin:0 0 4px">Nuevos productos en ${STORE_NAME}</h2>
    <p style="color:#666;margin:0 0 16px">Se detectaron <b>${newProducts.length}</b> ${plural} en la tienda.</p>
    <table style="width:100%;border-collapse:collapse">${cards}</table>
    <p style="color:#aaa;font-size:12px;margin-top:20px">Notificación automática · monitor de catálogo Ecwid</p>
  </div>`;

  const text = newProducts
    .map((p) => `• ${p.name || "(sin nombre)"} — ${p.defaultDisplayedPriceFormatted || ""}\n  ${p.url}`)
    .join("\n\n");

  return { subject, html, text };
}

async function sendEmail({ subject, html, text }) {
  if (!RESEND_API_KEY) {
    throw new Error("Falta RESEND_API_KEY en el entorno.");
  }
  if (!MAIL_TO) {
    throw new Error("Falta MAIL_TO en el entorno (configúralo como secret).");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [MAIL_TO],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---- Flujo principal ----
async function main() {
  if (!STORE_ID || !ECWID_TOKEN) {
    throw new Error(
      "Faltan ECWID_STORE_ID y/o ECWID_PUBLIC_TOKEN en el entorno.",
    );
  }

  const products = await fetchAllProducts();

  // Solo interesan los productos VISIBLES en la tienda. El resto son fichas
  // ocultas que la API devuelve sin nombre: si se guardaran como vistas, al
  // publicarse (caso típico de una pre-orden) ya no se detectarían como nuevas.
  const visible = products.filter((p) => p.enabled && p.name);
  const currentIds = new Set(visible.map((p) => p.id));
  console.log(
    `Catálogo: ${products.length} productos, ${visible.length} visibles.`,
  );

  const seen = await loadSeen();

  // Primera corrida: registrar todo sin notificar (evita cientos de emails).
  if (seen === null) {
    await saveSeen(currentIds);
    console.log("Primera corrida: estado inicial guardado, sin notificaciones.");
    return;
  }

  const newProducts = visible.filter((p) => !seen.has(p.id));

  // Los ids solo se agregan, nunca se quitan: si un producto se oculta y luego
  // vuelve, no se notifica de nuevo porque no es realmente nuevo.
  const updatedSeen = new Set([...seen, ...currentIds]);

  // Si el conjunto no cambió, no reescribir el archivo: evita un commit
  // inútil en cada corrida (el tracker corre cada 5 minutos).
  if (updatedSeen.size === seen.size) {
    console.log("Sin productos nuevos (estado sin cambios).");
    return;
  }

  if (newProducts.length === 0) {
    await saveSeen(updatedSeen);
    console.log("Sin productos nuevos, pero el catálogo cambió; estado actualizado.");
    return;
  }

  // No se registran nombres ni ids: en un repo público los logs de Actions
  // también son públicos.
  console.log(`¡${newProducts.length} producto(s) nuevo(s)!`);

  const email = buildEmail(newProducts);
  await sendEmail(email);
  console.log("Email enviado.");

  // Guardar estado solo después de enviar con éxito.
  await saveSeen(updatedSeen);
}

main().catch((err) => {
  console.error("Error en el tracker:", err.message);
  process.exit(1);
});
