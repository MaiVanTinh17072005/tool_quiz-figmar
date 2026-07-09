// Figma to HTML - Image CDN Plugin
// Scans selected layers, extracts styles/layout, exports images as base64,
// and sends the data to ui.html for HTML/CSS generation + CDN upload.

figma.showUI(__html__, { width: 860, height: 640 });

// ─── Helpers ──────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbaToCSS(r: number, g: number, b: number, a: number): string {
  if (a >= 1) return rgbToHex(r, g, b);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${parseFloat(a.toFixed(3))})`;
}

function extractSolidColor(paints: readonly Paint[]): string | undefined {
  const visible = paints.filter(p => p.visible !== false);
  for (const paint of visible) {
    if (paint.type === 'SOLID') {
      const opacity = paint.opacity !== undefined && paint.opacity !== null ? paint.opacity : 1;
      return rgbaToCSS(paint.color.r, paint.color.g, paint.color.b, opacity);
    }
  }
  return undefined;
}

function hasImageFill(node: SceneNode): boolean {
  if ('fills' in node) {
    const fills = node.fills;
    if (fills === figma.mixed) return false;
    const paintArray = fills as readonly Paint[];
    return paintArray.some(f => f.type === 'IMAGE' && f.visible !== false);
  }
  return false;
}

function hasOnlyImageOrNoFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed) return false;
  const paintArray = fills as readonly Paint[];
  const visibleFills = paintArray.filter(f => f.visible !== false);
  if (visibleFills.length === 0) return false;
  return visibleFills.every(f => f.type === 'IMAGE');
}

// Detect if a TEXT node contains only icon/symbol characters (not readable text)
// These are characters from icon fonts (SF Symbols, Material Icons, FontAwesome, etc.)
// or Unicode symbol ranges that render as icons in Figma but show as empty/boxes in HTML
function isSymbolText(node: SceneNode): boolean {
  if (node.type !== 'TEXT') return false;
  const textNode = node as TextNode;
  const text = textNode.characters.trim();

  // Empty text
  if (text.length === 0) return true;

  // Check every character: if ALL are non-printable/symbol/icon characters → it's a symbol
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;

    // Skip surrogate pair second half
    if (code > 0xFFFF) { i++; }

    // Allow whitespace
    if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) continue;

    // Common readable ASCII range (! through ~): 0x21 - 0x7E
    // If we find normal readable ASCII letters/digits → it's regular text
    if (code >= 0x21 && code <= 0x7E) return false;

    // Common readable Unicode Latin/CJK/Cyrillic ranges → regular text
    // Latin Extended: 0x00C0 - 0x024F
    if (code >= 0x00C0 && code <= 0x024F) return false;
    // CJK Unified: 0x4E00 - 0x9FFF
    if (code >= 0x4E00 && code <= 0x9FFF) return false;
    // Hangul: 0xAC00 - 0xD7AF
    if (code >= 0xAC00 && code <= 0xD7AF) return false;
    // Cyrillic: 0x0400 - 0x04FF
    if (code >= 0x0400 && code <= 0x04FF) return false;
    // Arabic: 0x0600 - 0x06FF
    if (code >= 0x0600 && code <= 0x06FF) return false;
    // Devanagari: 0x0900 - 0x097F
    if (code >= 0x0900 && code <= 0x097F) return false;
    // Vietnamese/Latin with diacritics: 0x1E00 - 0x1EFF
    if (code >= 0x1E00 && code <= 0x1EFF) return false;

    // Everything else (Private Use Area, Symbols, Dingbats, Emoji, etc.)
    // is treated as icon/symbol — continue checking next character
  }

  // All characters were symbol/icon/whitespace → this is a symbol text
  return true;
}

// Recursively check if a node tree contains only vector/shape/symbol elements (no readable text)
function containsOnlyVectorLike(node: SceneNode): boolean {
  const vectorTypes = ['VECTOR', 'STAR', 'LINE', 'POLYGON', 'BOOLEAN_OPERATION', 'ELLIPSE'];
  if (vectorTypes.indexOf(node.type) !== -1) return true;
  if (node.type === 'RECTANGLE') return true;

  // TEXT node containing symbol/icon characters counts as vector-like
  if (node.type === 'TEXT' && isSymbolText(node)) return true;
  // TEXT node with readable text → not vector-like
  if (node.type === 'TEXT') return false;

  // For containers (GROUP, FRAME, COMPONENT, INSTANCE), check all children recursively
  if ('children' in node) {
    const children = (node as FrameNode | GroupNode | ComponentNode | InstanceNode).children;
    if (children.length === 0) return true; // Empty container — treat as shape
    return children.every(function(c: SceneNode) {
      if (!c.visible) return true; // Skip hidden children
      return containsOnlyVectorLike(c);
    });
  }

  return false;
}

// Check if a node has a visible background (solid or gradient fill)
// Nodes with backgrounds should stay as HTML containers so the background is preserved in CSS
function hasVisibleBackground(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed) return false;
  const paintArray = fills as readonly Paint[];
  return paintArray.some(function(f) {
    return f.visible !== false && (f.type === 'SOLID' || f.type === 'GRADIENT_LINEAR' ||
      f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_ANGULAR' || f.type === 'GRADIENT_DIAMOND');
  });
}

// Check if a node looks like an icon based on its properties
function looksLikeIcon(node: SceneNode): boolean {
  // Must have children property to inspect
  if (!('children' in node)) return false;

  // If this node has a visible background, do NOT export it as an image —
  // keep it as an HTML container so its background is rendered via CSS,
  // and let the icon children inside be exported at their own level
  if (hasVisibleBackground(node)) return false;

  const children = (node as FrameNode | GroupNode | ComponentNode | InstanceNode).children;
  const visibleChildren = children.filter(function(c: SceneNode) { return c.visible; });

  // Case A: Container with all vector/shape/symbol children (recursive check)
  if (visibleChildren.length > 0 && containsOnlyVectorLike(node)) {
    return true;
  }

  // Case B: Small INSTANCE/COMPONENT (typical icon size ≤ 64px)
  if ((node.type === 'INSTANCE' || node.type === 'COMPONENT') && node.width <= 64 && node.height <= 64) {
    if (visibleChildren.length === 0) return true; // Empty instance — likely a symbol
    if (containsOnlyVectorLike(node)) return true;
  }

  // Case C: FRAME that is small and contains only vectors/shapes/symbols (icon wrapper)
  if (node.type === 'FRAME' && node.width <= 64 && node.height <= 64) {
    if (visibleChildren.length > 0 && containsOnlyVectorLike(node)) {
      return true;
    }
  }

  return false;
}

// Determine if a node should be exported as an image
function shouldExportAsImage(node: SceneNode): boolean {
  // 1. Any node with an image fill (RECTANGLE, ELLIPSE, FRAME, INSTANCE, COMPONENT, etc.)
  if (hasImageFill(node)) return true;

  // 2. Vector/icon types (always export as image)
  const vectorTypes = ['VECTOR', 'STAR', 'LINE', 'POLYGON', 'BOOLEAN_OPERATION'];
  if (vectorTypes.indexOf(node.type) !== -1) return true;

  // 3. ELLIPSE without children (likely a shape/icon)
  if (node.type === 'ELLIPSE') return true;

  // 4. SVG-like groups: groups containing only vector-type children
  if (node.type === 'GROUP' && 'children' in node) {
    const children = (node as GroupNode).children;
    if (children.length > 0 && children.every(function(c) {
      return vectorTypes.indexOf(c.type) !== -1 || c.type === 'GROUP' || c.type === 'ELLIPSE';
    })) {
      return true;
    }
  }

  // 5. RECTANGLE that ONLY has image fill (no solid color underneath) — it's an image container
  if (node.type === 'RECTANGLE' && hasOnlyImageOrNoFill(node) && hasImageFill(node)) {
    return true;
  }

  // 6. Icon/symbol detection: INSTANCE, COMPONENT, GROUP, or FRAME that looks like an icon
  // This catches icons that are symbols in Figma — they can be exported normally from Figma
  // but the plugin previously missed them because they weren't recognized as image-exportable
  if (looksLikeIcon(node)) {
    return true;
  }

  // 7. TEXT node containing only symbol/icon characters (SF Symbols, icon fonts, Unicode symbols)
  // These render as icons in Figma but show as empty boxes or nothing in HTML
  if (isSymbolText(node)) {
    return true;
  }

  return false;
}

function getBorderRadius(node: SceneNode): number | number[] | undefined {
  if (!('cornerRadius' in node)) return undefined;
  const n = node as RectangleNode | FrameNode | ComponentNode | InstanceNode;

  const cr = n.cornerRadius;
  if (cr !== figma.mixed && typeof cr === 'number' && cr > 0) {
    return cr;
  }

  if ('topLeftRadius' in n) {
    const tl = (n as any).topLeftRadius || 0;
    const tr = (n as any).topRightRadius || 0;
    const br = (n as any).bottomRightRadius || 0;
    const bl = (n as any).bottomLeftRadius || 0;
    if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
      if (tl === tr && tr === br && br === bl) return tl;
      return [tl, tr, br, bl];
    }
  }

  return undefined;
}

function getStroke(node: SceneNode): { color: string; width: number } | undefined {
  if (!('strokes' in node)) return undefined;
  const n = node as GeometryMixin & MinimalStrokesMixin;
  const strokes = n.strokes as readonly Paint[];
  if (!strokes || strokes.length === 0) return undefined;

  const color = extractSolidColor(strokes);
  if (!color) return undefined;

  const weight = ('strokeWeight' in n && typeof n.strokeWeight === 'number') ? n.strokeWeight : 1;
  return { color, width: weight };
}

function getEffects(node: SceneNode): { boxShadow?: string } {
  if (!('effects' in node)) return {};
  const effects = (node as any).effects as readonly Effect[];
  if (!effects || effects.length === 0) return {};

  const shadows: string[] = [];
  for (const effect of effects) {
    if (!effect.visible) continue;
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      const e = effect as DropShadowEffect;
      const color = rgbaToCSS(e.color.r, e.color.g, e.color.b, e.color.a);
      const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
      shadows.push(`${inset}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${(e.spread || 0)}px ${color}`);
    }
  }

  return shadows.length > 0 ? { boxShadow: shadows.join(', ') } : {};
}

// ─── Node data interfaces ──────────────────────────────

interface NodeData {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor?: string;
  opacity?: number;
  borderRadius?: number | number[];
  border?: { color: string; width: number };
  boxShadow?: string;
  overflow?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  textColor?: string;
  lineHeight?: string;
  letterSpacing?: number;
  textAlign?: string;
  textDecoration?: string;
  display?: string;
  flexDirection?: string;
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  alignItems?: string;
  justifyContent?: string;
  flexWrap?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  isImage: boolean;
  imageBase64?: string;
  children?: NodeData[];
}

// ─── Auto-layout mapping ───────────────────────────────

function mapAutoLayout(node: FrameNode | ComponentNode | InstanceNode): Partial<NodeData> {
  const result: Partial<NodeData> = {};

  if (node.layoutMode === 'NONE') return result;

  result.display = 'flex';
  result.flexDirection = node.layoutMode === 'VERTICAL' ? 'column' : 'row';
  result.gap = node.itemSpacing;

  result.padding = {
    top: node.paddingTop,
    right: node.paddingRight,
    bottom: node.paddingBottom,
    left: node.paddingLeft,
  };

  switch (node.primaryAxisAlignItems) {
    case 'MIN': result.justifyContent = 'flex-start'; break;
    case 'MAX': result.justifyContent = 'flex-end'; break;
    case 'CENTER': result.justifyContent = 'center'; break;
    case 'SPACE_BETWEEN': result.justifyContent = 'space-between'; break;
  }

  switch (node.counterAxisAlignItems) {
    case 'MIN': result.alignItems = 'flex-start'; break;
    case 'MAX': result.alignItems = 'flex-end'; break;
    case 'CENTER': result.alignItems = 'center'; break;
    case 'BASELINE': result.alignItems = 'baseline'; break;
  }

  if ('layoutWrap' in node && (node as any).layoutWrap === 'WRAP') {
    result.flexWrap = 'wrap';
  }

  return result;
}

// ─── Main tree scanner ─────────────────────────────────

async function scanNode(node: SceneNode, parentIsAutoLayout: boolean): Promise<NodeData> {
  const isImage = shouldExportAsImage(node);

  const data: NodeData = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    isImage: isImage,
  };

  // Opacity
  if ('opacity' in node && (node as any).opacity < 1) {
    data.opacity = (node as any).opacity;
  }

  // Background color (only for non-image nodes)
  if (!isImage && 'fills' in node && node.fills !== figma.mixed) {
    const bg = extractSolidColor(node.fills as readonly Paint[]);
    if (bg) data.backgroundColor = bg;
  }

  // Border radius
  const br = getBorderRadius(node);
  if (br) data.borderRadius = br;

  // Stroke/border
  const stroke = getStroke(node);
  if (stroke) data.border = stroke;

  // Box shadow
  const effects = getEffects(node);
  if (effects.boxShadow) data.boxShadow = effects.boxShadow;

  // Clip content
  if ('clipsContent' in node && (node as any).clipsContent) {
    data.overflow = 'hidden';
  }

  // ── IMAGE export (must be checked BEFORE TEXT to catch symbol/icon TEXT nodes) ──
  if (isImage) {
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      const base64 = figma.base64Encode(bytes);
      data.imageBase64 = base64;
      figma.ui.postMessage({ type: 'log', message: 'Exported image: ' + node.name + ' (' + base64.length + ' chars)' });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'log', message: 'FAILED to export image: ' + node.name + ' - ' + errMsg });
    }
    return data;
  }

  // ── TEXT node (only reached for non-symbol text, since symbol text is caught above as isImage) ──
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    data.text = textNode.characters;

    if (textNode.fontSize !== figma.mixed) {
      data.fontSize = textNode.fontSize as number;
    }

    if (textNode.fontName !== figma.mixed) {
      data.fontFamily = (textNode.fontName as FontName).family;
      const style = (textNode.fontName as FontName).style.toLowerCase();
      if (style.indexOf('bold') !== -1 || style.indexOf('black') !== -1 || style.indexOf('heavy') !== -1) {
        data.fontWeight = 700;
      } else if (style.indexOf('semibold') !== -1 || style.indexOf('demibold') !== -1) {
        data.fontWeight = 600;
      } else if (style.indexOf('medium') !== -1) {
        data.fontWeight = 500;
      } else if (style.indexOf('light') !== -1 || style.indexOf('thin') !== -1) {
        data.fontWeight = 300;
      } else {
        data.fontWeight = 400;
      }
    }

    if (textNode.fills !== figma.mixed) {
      const color = extractSolidColor(textNode.fills as readonly Paint[]);
      if (color) data.textColor = color;
    }

    if (textNode.lineHeight !== figma.mixed) {
      const lh = textNode.lineHeight as LineHeight;
      if (lh.unit === 'PIXELS') {
        data.lineHeight = lh.value + 'px';
      } else if (lh.unit === 'PERCENT') {
        data.lineHeight = lh.value + '%';
      }
    }

    if (textNode.letterSpacing !== figma.mixed) {
      const ls = textNode.letterSpacing as LetterSpacing;
      if (ls.unit === 'PIXELS' && ls.value !== 0) {
        data.letterSpacing = ls.value;
      } else if (ls.unit === 'PERCENT' && ls.value !== 0) {
        data.letterSpacing = ls.value / 100;
      }
    }

    if (textNode.textAlignHorizontal) {
      switch (textNode.textAlignHorizontal) {
        case 'LEFT': data.textAlign = 'left'; break;
        case 'CENTER': data.textAlign = 'center'; break;
        case 'RIGHT': data.textAlign = 'right'; break;
        case 'JUSTIFIED': data.textAlign = 'justify'; break;
      }
    }

    if (textNode.textDecoration !== figma.mixed && textNode.textDecoration !== 'NONE') {
      if (textNode.textDecoration === 'UNDERLINE') data.textDecoration = 'underline';
      else if (textNode.textDecoration === 'STRIKETHROUGH') data.textDecoration = 'line-through';
    }

    return data;
  }

  // ── FRAME / GROUP with auto-layout ──
  if ('layoutMode' in node) {
    const frameNode = node as FrameNode | ComponentNode | InstanceNode;
    const autoLayoutProps = mapAutoLayout(frameNode);
    Object.assign(data, autoLayoutProps);

    if ('layoutSizingHorizontal' in frameNode) {
      data.layoutSizingHorizontal = (frameNode as any).layoutSizingHorizontal;
    }
    if ('layoutSizingVertical' in frameNode) {
      data.layoutSizingVertical = (frameNode as any).layoutSizingVertical;
    }
  }

  // ── Also check: FRAME/INSTANCE/COMPONENT with image fill BUT also has children ──
  // In this case, export the background as image separately (handled by the node itself being isImage=false)
  // The image fill becomes a background-image in CSS — but for now, we just skip it

  // ── Recurse into children ──
  if ('children' in node) {
    const parent = node as FrameNode | GroupNode | ComponentNode | InstanceNode;
    const isAutoLayout = 'layoutMode' in node && (node as any).layoutMode !== 'NONE';
    const childResults: NodeData[] = [];
    for (const child of parent.children) {
      if (!child.visible) continue;
      const childData = await scanNode(child, isAutoLayout);
      childResults.push(childData);
    }
    data.children = childResults;
  }

  return data;
}

// ─── Message handler ───────────────────────────────────

figma.ui.onmessage = async (msg: { type: string }) => {
  if (msg.type === 'scan-selection') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Please select at least one layer or frame.' });
      figma.notify('Please select at least one layer or frame.', { error: true });
      return;
    }

    figma.ui.postMessage({ type: 'scan-start', count: selection.length });

    try {
      const results: NodeData[] = [];
      for (let i = 0; i < selection.length; i++) {
        figma.ui.postMessage({
          type: 'scan-progress',
          current: i + 1,
          total: selection.length,
          name: selection[i].name
        });
        const nodeData = await scanNode(selection[i], false);
        results.push(nodeData);
      }

      // Log image count for debugging
      let imageCount = 0;
      function countImages(n: NodeData) {
        if (n.isImage) imageCount++;
        if (n.children) n.children.forEach(countImages);
      }
      results.forEach(countImages);
      figma.ui.postMessage({ type: 'log', message: 'Total images found: ' + imageCount });

      figma.ui.postMessage({ type: 'scan-complete', nodes: results });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: 'Scan failed: ' + errorMsg });
    }
  }

  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};
