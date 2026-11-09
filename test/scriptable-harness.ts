/**
 * Minimal stand-in for the Scriptable iOS API, enough to run clients/ios/AI Pace.js under Node.
 * Objects only expose members that exist in the real API (unknown property writes and method
 * calls throw), so API typos fail here instead of on the phone. It also renders the widget to
 * HTML/SVG so the layout can be screenshotted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../clients/ios/AI Pace.js', import.meta.url));

type Any = Record<string, any>;

function strict<T extends object>(target: T, allowed: string[], name: string): T {
  return new Proxy(target, {
    set(t, prop, value) {
      if (typeof prop === 'string' && !allowed.includes(prop)) throw new TypeError(`${name}.${prop} não existe no Scriptable`);
      return Reflect.set(t, prop, value);
    },
    get(t, prop) {
      if (typeof prop === 'string' && !(prop in t) && !allowed.includes(prop) && prop !== 'then' && prop !== 'toJSON') {
        throw new TypeError(`${name}.${prop} não existe no Scriptable`);
      }
      return Reflect.get(t, prop);
    },
  });
}

export interface RunOptions {
  family: string;
  status: unknown;
  httpStatus?: number;
  param?: string;
  dark?: boolean;
  runsInApp?: boolean;
  keychain?: Record<string, string>;
  alertChoices?: number[];
  /** Share a FileManager store between runs (to test the offline cache). */
  files?: Map<string, string>;
}

export interface RunResult {
  widget: Any | null;
  presented: string | null;
  html: string;
  requests: { url: string; headers: Any }[];
}

export async function runWidget(opts: RunOptions): Promise<RunResult> {
  const dark = !!opts.dark;
  const requests: { url: string; headers: Any }[] = [];
  let widget: Any | null = null;
  let presented: string | null = null;
  const keychain = new Map(Object.entries(opts.keychain ?? { 'ai-pace.server': 'https://pi.example', 'ai-pace.token': 'tok' }));
  const files = opts.files ?? new Map<string, string>();
  const alertChoices = [...(opts.alertChoices ?? [])];

  class Color {
    hex: string;
    alpha: number;
    constructor(hex: string, alpha = 1) {
      this.hex = hex;
      this.alpha = alpha;
    }
    static dynamic(light: Color, darkC: Color) {
      return dark ? darkC : light;
    }
    static white() {
      return new Color('#ffffff');
    }
    static black() {
      return new Color('#000000');
    }
    static clear() {
      return new Color('#000000', 0);
    }
    css() {
      return this.alpha === 1 ? this.hex : `color-mix(in srgb, ${this.hex} ${Math.round(this.alpha * 100)}%, transparent)`;
    }
  }
  const font = (size: number, weight: number) => ({ size, weight });
  const Font = {
    systemFont: (s: number) => font(s, 400),
    mediumSystemFont: (s: number) => font(s, 500),
    semiboldSystemFont: (s: number) => font(s, 600),
    boldSystemFont: (s: number) => font(s, 700),
  };
  class Size {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  }
  class Point {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  }
  class Rect {
    x: number;
    y: number;
    width: number;
    height: number;
    constructor(x: number, y: number, w: number, h: number) {
      for (const v of [x, y, w, h]) if (!Number.isFinite(v)) throw new TypeError(`Rect com valor inválido: ${[x, y, w, h]}`);
      this.x = x;
      this.y = y;
      this.width = w;
      this.height = h;
    }
  }
  class Path {
    ops: string[] = [];
    addRoundedRect(r: Rect, cw: number, ch: number) {
      this.ops.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${Math.min(cw, r.width / 2)}" ry="${Math.min(ch, r.height / 2)}"`);
    }
    addRect(r: Rect) {
      this.ops.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"`);
    }
    addEllipse(r: Rect) {
      this.ops.push(`<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}"`);
    }
  }
  class DrawContext {
    size = new Size(100, 100);
    opaque = true;
    respectScreenScale = false;
    private els: string[] = [];
    private fill = new Color('#000');
    private stroke = new Color('#000');
    private lineWidth = 1;
    private font = font(12, 400);
    private textColor = new Color('#000');
    private align = 'left';
    private paths: string[] = [];
    setFillColor(c: Color) {
      this.fill = c;
    }
    setStrokeColor(c: Color) {
      this.stroke = c;
    }
    setLineWidth(w: number) {
      this.lineWidth = w;
    }
    fillRect(r: Rect) {
      this.els.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.fill.css()}"/>`);
    }
    fillEllipse(r: Rect) {
      this.els.push(`<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="${this.fill.css()}"/>`);
    }
    strokeEllipse(r: Rect) {
      this.els.push(
        `<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="none" stroke="${this.stroke.css()}" stroke-width="${this.lineWidth}"/>`,
      );
    }
    addPath(p: Path) {
      this.paths.push(...p.ops);
    }
    fillPath() {
      for (const op of this.paths) this.els.push(`${op} fill="${this.fill.css()}"/>`);
      this.paths = [];
    }
    strokePath() {
      for (const op of this.paths) this.els.push(`${op} fill="none" stroke="${this.stroke.css()}" stroke-width="${this.lineWidth}"/>`);
      this.paths = [];
    }
    setFont(f: Any) {
      this.font = f as typeof this.font;
    }
    setTextColor(c: Color) {
      this.textColor = c;
    }
    setTextAlignedCenter() {
      this.align = 'center';
    }
    setTextAlignedLeft() {
      this.align = 'left';
    }
    setTextAlignedRight() {
      this.align = 'right';
    }
    drawTextInRect(text: string, r: Rect) {
      const x = this.align === 'center' ? r.x + r.width / 2 : this.align === 'right' ? r.x + r.width : r.x;
      const anchor = this.align === 'center' ? 'middle' : this.align === 'right' ? 'end' : 'start';
      this.els.push(
        `<text x="${x}" y="${r.y}" dominant-baseline="hanging" text-anchor="${anchor}" font-size="${this.font.size}" font-weight="${this.font.weight}" fill="${this.textColor.css()}" font-family="system-ui">${escapeXml(text)}</text>`,
      );
    }
    getImage() {
      return { svg: this.els.join(''), width: this.size.width, height: this.size.height };
    }
  }

  const textProps = ['text', 'textColor', 'font', 'textOpacity', 'lineLimit', 'minimumScaleFactor', 'url', 'align'];
  const imageProps = ['image', 'resizable', 'imageSize', 'imageOpacity', 'cornerRadius', 'tintColor', 'url', 'align'];
  const stackProps = ['backgroundColor', 'spacing', 'size', 'cornerRadius', 'url', 'children', 'layout', 'padding', 'align'];

  function container(kind: string, allowedExtra: string[]): Any {
    const node: Any = {
      kind,
      children: [] as Any[],
      layout: kind === 'stack' ? 'h' : 'v',
      padding: kind === 'widget' ? [16, 16, 16, 16] : [0, 0, 0, 0],
      align: 'center',
      addText(text: string) {
        const t = strict({ kind: 'text', text, align: 'left', centerAlignText() {}, leftAlignText() {}, rightAlignText() {} } as Any, textProps, 'WidgetText');
        node.children.push(t);
        return t;
      },
      addImage(image: Any) {
        const i: Any = strict(
          {
            kind: 'image',
            image,
            align: 'left',
            centerAlignImage() {
              i.align = 'center';
            },
            leftAlignImage() {},
            rightAlignImage() {},
          } as Any,
          imageProps,
          'WidgetImage',
        );
        node.children.push(i);
        return i;
      },
      addSpacer(length?: number) {
        const s = { kind: 'spacer', length: length ?? null };
        node.children.push(s);
        return s;
      },
      addStack() {
        const s = container('stack', []);
        node.children.push(s);
        return s;
      },
      setPadding(t: number, l: number, b: number, r: number) {
        node.padding = [t, l, b, r];
      },
      useDefaultPadding() {},
      layoutHorizontally() {
        node.layout = 'h';
      },
      layoutVertically() {
        node.layout = 'v';
      },
      centerAlignContent() {
        node.align = 'center';
      },
      topAlignContent() {
        node.align = 'start';
      },
      bottomAlignContent() {
        node.align = 'end';
      },
    };
    const presenters = ['presentSmall', 'presentMedium', 'presentLarge', 'presentExtraLarge', 'presentAccessoryRectangular', 'presentAccessoryCircular', 'presentAccessoryInline'];
    if (kind === 'widget') {
      for (const p of presenters) {
        node[p] = async () => {
          presented = p;
        };
      }
    }
    const allowed = [
      ...stackProps,
      ...allowedExtra,
      ...Object.keys(node),
      ...(kind === 'widget' ? ['refreshAfterDate', 'addAccessoryWidgetBackground', 'backgroundImage', 'backgroundGradient'] : []),
    ];
    return strict(node, allowed, kind === 'widget' ? 'ListWidget' : 'WidgetStack');
  }

  class ListWidget {
    constructor() {
      return container('widget', []);
    }
  }

  class Request {
    url: string;
    headers: Any = {};
    method = 'GET';
    timeoutInterval = 60;
    response: Any | null = null;
    constructor(url: string) {
      this.url = url;
      return strict(this, ['url', 'headers', 'method', 'timeoutInterval', 'response', 'body', 'onRedirect'], 'Request');
    }
    async loadJSON() {
      requests.push({ url: this.url, headers: this.headers });
      if (opts.httpStatus === 0) throw new Error('The Internet connection appears to be offline.');
      this.response = { statusCode: opts.httpStatus ?? 200 };
      return opts.httpStatus && opts.httpStatus !== 200 ? { error: 'falhou' } : structuredClone(opts.status);
    }
  }

  const FileManager = {
    local: () =>
      strict(
        {
          cacheDirectory: () => '/cache',
          documentsDirectory: () => '/docs',
          joinPath: (a: string, b: string) => `${a}/${b}`,
          fileExists: (p: string) => files.has(p),
          readString: (p: string) => files.get(p),
          writeString: (p: string, s: string) => void files.set(p, s),
        },
        [],
        'FileManager',
      ),
  };
  const Keychain = strict(
    {
      contains: (k: string) => keychain.has(k),
      get: (k: string) => keychain.get(k),
      set: (k: string, v: string) => void keychain.set(k, v),
      remove: (k: string) => void keychain.delete(k),
    },
    [],
    'Keychain',
  );
  class Alert {
    title = '';
    message = '';
    private fields: string[] = [];
    constructor() {
      return strict(this, ['title', 'message'], 'Alert');
    }
    addTextField(_p: string, v = '') {
      this.fields.push(v);
    }
    addSecureTextField(_p: string, v = '') {
      this.fields.push(v);
    }
    addAction() {}
    addCancelAction() {}
    async presentAlert() {
      return alertChoices.length ? alertChoices.shift()! : -1;
    }
    textFieldValue(i: number) {
      return this.fields[i] ?? '';
    }
  }

  const accessory = opts.family.startsWith('accessory');
  const config = { runsInWidget: !opts.runsInApp, runsInApp: !!opts.runsInApp, runsInAccessoryWidget: accessory && !opts.runsInApp, widgetFamily: opts.runsInApp ? null : opts.family };
  const Script = {
    setWidget: (w: Any) => {
      widget = w;
    },
    complete: () => {},
  };
  const args = { widgetParameter: opts.param ?? null };

  const source = readFileSync(SCRIPT_PATH, 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const names = ['Color', 'Font', 'Size', 'Point', 'Rect', 'Path', 'DrawContext', 'ListWidget', 'Request', 'FileManager', 'Keychain', 'Alert', 'config', 'Script', 'args'];
  const fn = new AsyncFunction(...names, `"use strict";\n${source}`);
  await fn(Color, Font, Size, Point, Rect, Path, DrawContext, ListWidget, Request, FileManager, Keychain, Alert, config, Script, args);

  return { widget, presented, requests, html: widget ? renderHtml(widget, opts.family, dark) : '' };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const FRAME: Record<string, [number, number]> = {
  small: [158, 158],
  medium: [338, 158],
  large: [338, 354],
  accessoryRectangular: [160, 72],
  accessoryCircular: [72, 72],
  accessoryInline: [240, 22],
};

function renderNode(n: Any): string {
  if (n.kind === 'spacer') return n.length == null ? '<div style="flex:1"></div>' : `<div style="flex:0 0 ${n.length}px"></div>`;
  if (n.kind === 'text') {
    const f = n.font ?? { size: 14, weight: 400 };
    const color = n.textColor ? n.textColor.css() : 'inherit';
    const clamp = n.lineLimit === 1 ? 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' : '';
    return `<span style="font-size:${f.size}px;font-weight:${f.weight};color:${color};${clamp}min-width:0">${escapeXml(n.text)}</span>`;
  }
  if (n.kind === 'image') {
    const { width, height, svg } = n.image;
    const s = n.imageSize ?? { width, height };
    const self = n.align === 'center' ? 'align-self:center;' : '';
    return `<svg style="${self}flex:none" width="${s.width}" height="${s.height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`;
  }
  const dir = n.layout === 'h' ? 'row' : 'column';
  const [t, l, b, r] = n.padding;
  const align = n.layout === 'h' ? `align-items:${n.align === 'center' ? 'center' : n.align}` : 'align-items:stretch';
  return `<div style="display:flex;flex-direction:${dir};${align};padding:${t}px ${r}px ${b}px ${l}px;min-width:0;${n.backgroundColor ? `background:${n.backgroundColor.css()};` : ''}">${n.children.map(renderNode).join('')}</div>`;
}

function renderHtml(w: Any, family: string, dark: boolean): string {
  const [width, height] = FRAME[family] ?? [158, 158];
  const accessory = family.startsWith('accessory');
  const bg = w.backgroundColor ? w.backgroundColor.css() : accessory ? 'transparent' : dark ? '#1a1a19' : '#fcfcfb';
  const radius = family === 'accessoryCircular' ? '50%' : accessory ? '12px' : '22px';
  const acc = w.addAccessoryWidgetBackground ? 'background:rgba(255,255,255,.18);' : '';
  const [t, l, b, r] = w.padding;
  return `<div class="frame" style="width:${width}px;height:${height}px;border-radius:${radius};overflow:hidden;background:${bg};${acc}color:${accessory ? '#fff' : dark ? '#f0efec' : '#0b0b0b'};font-family:system-ui;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:${t}px ${r}px ${b}px ${l}px">${w.children.map(renderNode).join('')}</div>`;
}
