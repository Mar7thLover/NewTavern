import { ZoomIn, ZoomOut } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal';
import { Button } from './ui/button';
import { IconButton } from './ui/icon-button';
import { cn } from '../lib/utils';

/** 解码后先把长边缩到这个尺寸以内再操作，避免手机上整张大图常驻内存 */
const MAX_WORKING_EDGE = 2048;
const KEY_STEP = 10;
const KEY_STEP_LARGE = 40;
const KEY_ZOOM = 1.1;

export type CropOutputType = 'image/webp' | 'image/png';

export interface CropResult {
  blob: Blob;
  /** WebP 优先；浏览器不支持编码 WebP 时是 PNG */
  type: CropOutputType;
  /** 输出边长（像素，正方形） */
  size: number;
}

export interface ImageCropperProps {
  /** 图片文件，或已有的图片 URL（object URL 等） */
  source: Blob | string;
  /** 输出边长上限，默认 512；源图短边更小时按短边，不放大 */
  outputSize?: number;
  /** 最大缩放（相对「刚好铺满视窗」），默认 4 */
  maxZoom?: number;
  /** WebP 质量，默认 0.9 */
  quality?: number;
  /** 视窗里的参考线：`circle` 叠一个圆形预览（裁切结果始终是正方形） */
  guide?: 'circle' | 'none';
  onConfirm: (result: CropResult) => void;
  onCancel: () => void;
  /** 提供时显示「重新选择」 */
  onReselect?: () => void;
  className?: string;
}

interface WorkingImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

/** 视图：缩放（1 = 短边刚好铺满视窗）+ 视窗中心对应的图片坐标（工作图像素） */
interface View {
  zoom: number;
  cx: number;
  cy: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** 长边超过上限时缩到上限内（画进 canvas），并释放原图 */
function shrink(
  image: CanvasImageSource,
  width: number,
  height: number,
  dispose: () => void,
  alwaysCopy: boolean,
): WorkingImage {
  const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(width, height));
  if (scale === 1 && !alwaysCopy) return { image, width, height, dispose };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  dispose();
  return {
    image: canvas,
    width: canvas.width,
    height: canvas.height,
    dispose: () => {
      // 立刻归还位图内存（iOS Safari 对 canvas 总量很敏感）
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/** 解码：优先 createImageBitmap（按 EXIF 方向摆正），不支持时回退 <img> */
async function decodeSource(source: Blob | string): Promise<WorkingImage> {
  if (typeof source !== 'string' && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
      return shrink(bitmap, bitmap.width, bitmap.height, () => bitmap.close(), false);
    } catch {
      // 旧浏览器不认 options 或解码失败：交给 <img> 再试一次
    }
  }
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸为 0');
    // <img> 依赖 URL，复制进 canvas 后才能安全释放 object URL
    return shrink(img, img.naturalWidth, img.naturalHeight, () => undefined, true);
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

function clampView(view: View, width: number, height: number, maxZoom: number): View {
  const zoom = clamp(view.zoom, 1, Math.max(1, maxZoom));
  const side = Math.min(width, height) / zoom;
  return {
    zoom,
    cx: clamp(view.cx, side / 2, width - side / 2),
    cy: clamp(view.cy, side / 2, height - side / 2),
  };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

async function encodeSquare(
  working: WorkingImage,
  view: View,
  outputSize: number,
  quality: number,
): Promise<CropResult> {
  const side = Math.min(working.width, working.height) / view.zoom;
  const size = Math.max(
    1,
    Math.min(Math.round(outputSize), Math.floor(Math.min(working.width, working.height))),
  );
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    working.image,
    view.cx - side / 2,
    view.cy - side / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  try {
    // 不支持 WebP 编码的浏览器会静默给出 PNG（或 null）
    const webp = await toBlob(canvas, 'image/webp', quality);
    if (webp?.type === 'image/webp') return { blob: webp, type: 'image/webp', size };
    if (webp?.type === 'image/png') return { blob: webp, type: 'image/png', size };
    const png = await toBlob(canvas, 'image/png');
    if (!png) throw new Error('图片编码失败');
    return { blob: png, type: 'image/png', size };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 把裁切结果包成可上传的 File（`<baseName>.webp` / `.png`） */
export function cropResultToFile(result: CropResult, baseName = 'image'): File {
  const ext = result.type === 'image/webp' ? 'webp' : 'png';
  return new File([result.blob], `${baseName}.${ext}`, { type: result.type });
}

/**
 * 正方形图片裁切：固定正方形视窗，拖动图片定位，滑块 / 滚轮 / 双指缩放。
 * 图片始终铺满视窗（不会出现空白边），输出正方形 Blob。
 */
export function ImageCropper({
  source,
  outputSize = 512,
  maxZoom = 4,
  quality = 0.9,
  guide = 'circle',
  onConfirm,
  onCancel,
  onReselect,
  className,
}: ImageCropperProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [working, setWorking] = useState<WorkingImage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<View>({ zoom: 1, cx: 0, cy: 0 });
  const [viewportSize, setViewportSize] = useState(0);
  const [encoding, setEncoding] = useState(false);
  const [encodeError, setEncodeError] = useState(false);

  // 手势处理器里读最新值，避免闭包过期
  const latest = useRef({ working, view, viewportSize, maxZoom });
  useLayoutEffect(() => {
    latest.current = { working, view, viewportSize, maxZoom };
  });

  // 解码源图；换图时视图复位到居中、铺满
  useEffect(() => {
    let cancelled = false;
    let decoded: WorkingImage | null = null;
    setStatus('loading');
    setWorking(null);
    setEncodeError(false);
    decodeSource(source).then(
      (result) => {
        if (cancelled) {
          result.dispose();
          return;
        }
        decoded = result;
        setWorking(result);
        setView({ zoom: 1, cx: result.width / 2, cy: result.height / 2 });
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );
    return () => {
      cancelled = true;
      decoded?.dispose();
    };
  }, [source]);

  // 视窗尺寸（CSS 像素，正方形）
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewportSize(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 打开时让视窗拿到焦点，方向键 / Enter / Esc 立即可用
  useEffect(() => {
    viewportRef.current?.focus({ preventScroll: true });
  }, []);

  // 绘制：视窗里画的就是将要输出的那块正方形
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !working || viewportSize <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const pixels = Math.max(1, Math.round(viewportSize * ratio));
    if (canvas.width !== pixels) canvas.width = pixels;
    if (canvas.height !== pixels) canvas.height = pixels;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const side = Math.min(working.width, working.height) / view.zoom;
    ctx.clearRect(0, 0, pixels, pixels);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      working.image,
      view.cx - side / 2,
      view.cy - side / 2,
      side,
      side,
      0,
      0,
      pixels,
      pixels,
    );
  }, [working, view, viewportSize]);

  /** 平移：dx/dy 是视窗里的 CSS 像素，方向与手指一致（图片跟着走） */
  const pan = useCallback((dx: number, dy: number) => {
    const { working: image, viewportSize: size, maxZoom: max } = latest.current;
    if (!image || size <= 0) return;
    setView((current) => {
      const scale = (size / Math.min(image.width, image.height)) * current.zoom;
      const next = clampView(
        { zoom: current.zoom, cx: current.cx - dx / scale, cy: current.cy - dy / scale },
        image.width,
        image.height,
        max,
      );
      latest.current.view = next;
      return next;
    });
  }, []);

  /** 以视窗内一点（CSS 像素，默认中心）为不动点缩放 */
  const zoomTo = useCallback((getZoom: (zoom: number) => number, px?: number, py?: number) => {
    const { working: image, viewportSize: size, maxZoom: max } = latest.current;
    if (!image || size <= 0) return;
    setView((current) => {
      const base = size / Math.min(image.width, image.height);
      const ox = (px ?? size / 2) - size / 2;
      const oy = (py ?? size / 2) - size / 2;
      const ix = current.cx + ox / (base * current.zoom);
      const iy = current.cy + oy / (base * current.zoom);
      const zoom = clamp(getZoom(current.zoom), 1, Math.max(1, max));
      const next = clampView(
        { zoom, cx: ix - ox / (base * zoom), cy: iy - oy / (base * zoom) },
        image.width,
        image.height,
        max,
      );
      latest.current.view = next;
      return next;
    });
  }, []);

  // 滚轮缩放：React 的 onWheel 是 passive，拦不住弹窗滚动，改用原生监听
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp((-event.deltaY * unit) / 500);
      const rect = element.getBoundingClientRect();
      zoomTo((zoom) => zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // 指针：一指拖动，两指捏合（缩放 + 跟随两指中点平移）
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; x: number; y: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinch.current = null;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      pan(event.clientX - previous.x, event.clientY - previous.y);
      return;
    }
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const current = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
    };
    const last = pinch.current;
    if (last && last.distance > 0) {
      zoomTo((zoom) => (zoom * current.distance) / last.distance, last.x, last.y);
      pan(current.x - last.x, current.y - last.y);
    }
    pinch.current = current;
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
  };

  const confirm = async () => {
    const image = latest.current.working;
    if (!image || encoding) return;
    setEncoding(true);
    setEncodeError(false);
    try {
      const result = await encodeSquare(image, latest.current.view, outputSize, quality);
      onConfirm(result);
    } catch {
      setEncodeError(true);
    } finally {
      setEncoding(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    switch (event.key) {
      case 'ArrowLeft':
        pan(-step, 0);
        break;
      case 'ArrowRight':
        pan(step, 0);
        break;
      case 'ArrowUp':
        pan(0, -step);
        break;
      case 'ArrowDown':
        pan(0, step);
        break;
      case '+':
      case '=':
        zoomTo((zoom) => zoom * KEY_ZOOM);
        break;
      case '-':
      case '_':
        zoomTo((zoom) => zoom / KEY_ZOOM);
        break;
      case 'Enter':
        if (status === 'ready') void confirm();
        break;
      case 'Escape':
        onCancel();
        break;
      default:
        return;
    }
    // 不让外层（弹窗的 Esc、表单的 Enter、滚动）再处理一遍
    event.preventDefault();
    event.stopPropagation();
  };

  const ready = status === 'ready';
  const zoomPercent = Math.round(view.zoom * 100);

  return (
    <div data-part="image-cropper" className={cn('flex flex-col gap-3', className)}>
      <div
        ref={viewportRef}
        data-part="image-cropper-viewport"
        data-status={status}
        role="application"
        aria-roledescription={t('common.cropper.viewportRole')}
        aria-label={t('common.cropper.viewport')}
        aria-describedby={hintId}
        aria-busy={status === 'loading'}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        className={cn(
          'surface-control edge-rule focus-ring relative mx-auto aspect-square w-full max-w-88 touch-none overflow-hidden border select-none',
          ready ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          className={cn('absolute inset-0 size-full', !ready && 'invisible')}
        />
        {ready && guide === 'circle' && (
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 size-full"
          >
            {/* 圆外压暗：只是预览参考，输出仍是整个正方形 */}
            <path
              d="M0 0H100V100H0Z M50 0.5A49.5 49.5 0 1 0 50 99.5A49.5 49.5 0 1 0 50 0.5Z"
              fillRule="evenodd"
              className="fill-overlay"
            />
            {/* 双线：底色晕 + 墨线，任何图片、任何主题上都看得见 */}
            <circle
              cx="50"
              cy="50"
              r="49.5"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-canvas opacity-60"
            />
            <circle
              cx="50"
              cy="50"
              r="49.5"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-ink opacity-80"
            />
          </svg>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-ink-2">
            {status === 'loading' ? (
              <span className="pulse-live">{t('common.loading')}</span>
            ) : (
              <span role="alert" className="text-danger">
                {t('common.cropper.loadFailed')}
              </span>
            )}
          </div>
        )}
      </div>

      <p id={hintId} className="text-center text-xs text-ink-3">
        {t('common.cropper.hint')}
      </p>

      <div
        data-part="image-cropper-zoom"
        className="mx-auto flex w-full max-w-88 items-center gap-2"
      >
        <IconButton
          label={t('common.cropper.zoomOut')}
          disabled={!ready || view.zoom <= 1}
          onClick={() => zoomTo((zoom) => zoom / KEY_ZOOM)}
        >
          <ZoomOut aria-hidden />
        </IconButton>
        <input
          type="range"
          min={1}
          max={maxZoom}
          step={0.01}
          value={view.zoom}
          disabled={!ready}
          aria-label={t('common.cropper.zoom')}
          aria-valuetext={`${zoomPercent}%`}
          onChange={(event) => {
            const target = Number(event.target.value);
            zoomTo(() => target);
          }}
          className="focus-ring h-7 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50"
        />
        <IconButton
          label={t('common.cropper.zoomIn')}
          disabled={!ready || view.zoom >= maxZoom}
          onClick={() => zoomTo((zoom) => zoom * KEY_ZOOM)}
        >
          <ZoomIn aria-hidden />
        </IconButton>
      </div>

      {encodeError && (
        <p role="alert" className="text-center text-xs text-danger">
          {t('common.cropper.exportFailed')}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {onReselect && (
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            disabled={encoding}
            onClick={onReselect}
          >
            {t('common.cropper.reselect')}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={encoding} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" disabled={!ready || encoding} onClick={() => void confirm()}>
          {encoding ? t('common.processing') : t('common.cropper.confirm')}
        </Button>
      </div>
    </div>
  );
}

/** 叠在当前界面之上的裁切弹窗：Esc / 遮罩只关闭它自己（Modal 栈保证） */
export function ImageCropperDialog({
  title,
  ...props
}: ImageCropperProps & {
  /** 弹窗标题，默认「裁切图片」 */
  title?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={props.onCancel} size="md" title={title ?? t('common.cropper.title')}>
      <ImageCropper {...props} />
    </Modal>
  );
}
