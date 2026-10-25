// Creative templates: turn a few fields (and an optional photo) into a 1920×1080 SVG ad.
// All text is XML-escaped; photos are content-sniffed and embedded as data URIs.
import { HttpError } from './http.ts';
import { sniffImage } from './uploads.ts';

export const TEMPLATES = ['bold', 'split', 'photo'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface TemplateInput {
  template: TemplateName;
  headline: string;
  subline?: string;
  cta?: string;
  businessName?: string;
  bgColor?: string;
  accentColor?: string;
  photoBase64?: string;
}

const W = 1920;
const H = 1080;
const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Greedy word wrap by character count, capped at maxLines (last line gets an ellipsis if truncated). */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{0,1}$/, '…');
    return kept;
  }
  return lines;
}

/** Black or white text, whichever contrasts more with the background (WCAG relative luminance). */
export function contrastText(hex: string): '#ffffff' | '#111111' {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#111111' : '#ffffff';
}

function color(v: unknown, field: string, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, `${field} must be #rrggbb`);
  return v.toLowerCase();
}

function text(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v.trim();
}

function textBlock(lines: string[], x: number, y: number, size: number, fill: string, weight: number, anchor = 'start'): string {
  return lines.map((l, i) =>
    `<text x="${x}" y="${y + i * size * 1.12}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${FONT}>${xml(l)}</text>`).join('');
}

function ctaPill(label: string, x: number, y: number, bg: string, anchor: 'start' | 'middle' = 'start'): string {
  if (!label) return '';
  const w = Math.min(1400, 80 + label.length * 30);
  const left = anchor === 'middle' ? x - w / 2 : x;
  return `<rect x="${left}" y="${y}" width="${w}" height="110" rx="55" fill="${bg}"/>` +
    `<text x="${left + w / 2}" y="${y + 72}" font-size="52" font-weight="700" fill="${contrastText(bg)}" text-anchor="middle" ${FONT}>${xml(label)}</text>`;
}

export function renderTemplate(raw: any): string {
  const template = raw?.template as TemplateName;
  if (!TEMPLATES.includes(template)) throw new HttpError(400, `template must be one of: ${TEMPLATES.join(', ')}`);
  const headline = text(raw.headline, 'headline', 60, true);
  const subline = text(raw.subline, 'subline', 120);
  const cta = text(raw.cta, 'cta', 40);
  const biz = text(raw.businessName, 'businessName', 40);
  const bg = color(raw.bgColor, 'bgColor', '#0f766e');
  const accent = color(raw.accentColor, 'accentColor', '#facc15');

  let photo = '';
  if (raw.photoBase64) {
    if (typeof raw.photoBase64 !== 'string') throw new HttpError(400, 'photoBase64 must be a string');
    const buf = Buffer.from(raw.photoBase64.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo too large (max 4 MB)');
    const kind = sniffImage(buf);
    if (!kind) throw new HttpError(400, 'photo must be PNG, JPEG or WebP');
    photo = `data:${kind.mime};base64,${buf.toString('base64')}`;
  } else if (template === 'photo') {
    throw new HttpError(400, 'the photo template needs a photo');
  }

  const fg = contrastText(bg);
  let body: string;
  if (template === 'bold') {
    const h = wrap(headline, 18, 3);
    const s = wrap(subline, 42, 2);
    const top = 360 - (h.length - 1) * 70;
    body = `<rect width="${W}" height="${H}" fill="${bg}"/>` +
      `<rect x="0" y="${H - 24}" width="${W}" height="24" fill="${accent}"/>` +
      (biz ? textBlock([biz], 120, 140, 48, fg, 600) : '') +
      textBlock(h, W / 2, top, 150, fg, 800, 'middle') +
      textBlock(s, W / 2, top + h.length * 168 + 30, 62, fg, 400, 'middle') +
      ctaPill(cta, W / 2, 820, accent, 'middle');
  } else if (template === 'split') {
    const panel = 1060;
    const h = wrap(headline, 13, 4);
    const s = wrap(subline, 30, 3);
    body = `<rect width="${W}" height="${H}" fill="${bg}"/>` +
      (photo
        ? `<image href="${photo}" x="${panel}" y="0" width="${W - panel}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect x="${panel}" y="0" width="${W - panel}" height="${H}" fill="${accent}" opacity="0.9"/>`) +
      (biz ? textBlock([biz], 110, 150, 46, fg, 600) : '') +
      textBlock(h, 110, 330, 120, fg, 800) +
      textBlock(s, 110, 330 + h.length * 134 + 20, 54, fg, 400) +
      ctaPill(cta, 110, 870, accent);
  } else {
    const h = wrap(headline, 24, 2);
    const s = wrap(subline, 50, 2);
    body = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient></defs>` +
      `<image href="${photo}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` +
      `<rect width="${W}" height="${H}" fill="url(#g)"/>` +
      (biz ? `<rect x="90" y="80" width="${80 + biz.length * 26}" height="80" rx="40" fill="${bg}"/>` + textBlock([biz], 130, 135, 42, fg, 700) : '') +
      textBlock(h, 110, 760 - (h.length - 1) * 130, 130, '#ffffff', 800) +
      textBlock(s, 110, 860, 54, '#ffffff', 400) +
      (cta ? ctaPill(cta, W - 110 - Math.min(1400, 80 + cta.length * 30), 900, accent) : '');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
}
