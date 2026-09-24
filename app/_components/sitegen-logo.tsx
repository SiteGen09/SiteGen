import Image from 'next/image';
import styles from './sitegen-logo.module.css';

/** Decorative mark; pair it with a visible name or an accessible link label. */
export function SitegenMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/brand/sitegen-mark.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`${styles.mark} ${className ?? ''}`}
      loading="eager"
      unoptimized
    />
  );
}

export function SitegenLogo({ className }: { className?: string }) {
  return (
    <span className={`${styles.logo} ${className ?? ''}`}>
      <SitegenMark />
      <span>sitegen<span className={styles.period} aria-hidden="true">.</span></span>
    </span>
  );
}
