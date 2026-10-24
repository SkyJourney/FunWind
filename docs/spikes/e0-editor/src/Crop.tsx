import { useCallback, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

type Area = { x: number; y: number; width: number; height: number };

/** 与计划里「服务端 sharp 裁剪」对应：这里只产出「原图像素坐标」的裁剪区域与旋转角度 */
export function CropLab() {
  const [lib, setLib] = useState<"easy" | "image">("easy");
  const [url, setUrl] = useState<string | null>(null);
  const [aspectMode, setAspectMode] = useState<"free" | "1:1" | "16:9">("1:1");
  const aspect = aspectMode === "1:1" ? 1 : aspectMode === "16:9" ? 16 / 9 : undefined;
  const [result, setResult] = useState<string>("（选择图片后拖动 / 缩放 / 旋转）");
  const onFile = (f?: File | null) => {
    if (f) setUrl(URL.createObjectURL(f));
  };
  return (
    <div>
      <div className="row">
        <button className={"btn" + (lib === "easy" ? " on" : "")} onClick={() => setLib("easy")}>
          react-easy-crop
        </button>
        <button className={"btn" + (lib === "image" ? " on" : "")} onClick={() => setLib("image")}>
          react-image-crop
        </button>
        <select value={aspectMode} onChange={(e) => setAspectMode(e.target.value as any)}>
          <option value="1:1">1:1（头像）</option>
          <option value="16:9">16:9</option>
          <option value="free">自由比例（正文插图）</option>
        </select>
      </div>
      <div className="row">
        <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {url && lib === "easy" && (
        <EasyCrop url={url} aspect={aspect ?? 4 / 3} onResult={setResult} />
      )}
      {url && lib === "image" && <ImageCrop url={url} aspect={aspect} onResult={setResult} />}
      <pre className="json">{result}</pre>
    </div>
  );
}

function EasyCrop({
  url,
  aspect,
  onResult,
}: {
  url: string;
  aspect: number;
  onResult: (s: string) => void;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const onComplete = useCallback(
    (_p: Area, px: Area) =>
      onResult(
        JSON.stringify({ lib: "react-easy-crop", crop: px, rotate: rotation, zoom }, null, 1),
      ),
    [rotation, zoom, onResult],
  );
  return (
    <div>
      <div className="crop-box">
        <Cropper
          image={url}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={aspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onRotationChange={setRotation}
          onCropComplete={onComplete}
        />
      </div>
      <div className="row">
        <button className="btn" onClick={() => setZoom((z) => Math.max(1, z - 0.2))}>
          缩小
        </button>
        <button className="btn" onClick={() => setZoom((z) => Math.min(5, z + 0.2))}>
          放大
        </button>
        <button className="btn" onClick={() => setRotation((r) => (r + 90) % 360)}>
          旋转 90°
        </button>
        <span>
          zoom {zoom.toFixed(1)} · rot {rotation}°
        </span>
      </div>
    </div>
  );
}

function ImageCrop({
  url,
  aspect,
  onResult,
}: {
  url: string;
  aspect?: number;
  onResult: (s: string) => void;
}) {
  const [crop, setCrop] = useState<PercentCrop>();
  const img = useRef<HTMLImageElement>(null);
  return (
    <div>
      <ReactCrop
        crop={crop}
        aspect={aspect}
        onChange={(_px, pct) => setCrop(pct)}
        onComplete={(px) => {
          const el = img.current;
          if (!el || !px.width) return;
          const sx = el.naturalWidth / el.width,
            sy = el.naturalHeight / el.height;
          onResult(
            JSON.stringify(
              {
                lib: "react-image-crop",
                crop: {
                  x: Math.round(px.x * sx),
                  y: Math.round(px.y * sy),
                  width: Math.round(px.width * sx),
                  height: Math.round(px.height * sy),
                },
                rotate: 0,
              },
              null,
              1,
            ),
          );
        }}
      >
        <img ref={img} src={url} style={{ maxWidth: "100%", maxHeight: 360 }} />
      </ReactCrop>
      <div className="row">
        <small>该库无内置旋转 / 缩放手势；键盘：聚焦裁剪框后用方向键微调</small>
      </div>
    </div>
  );
}
