import Image from "next/image";

/** The chosen Voicebird artwork is served unchanged, without a wordmark. */
export function BrandMark({ size = 56 }: { size?: number }) {
  return <Image
    src="/brand/dir-echoes-mark.png"
    alt="DIR ECHOES"
    width={size}
    height={size}
    unoptimized
    style={{ width: size, height: size, objectFit: "contain", display: "block", flexShrink: 0 }}
  />;
}
