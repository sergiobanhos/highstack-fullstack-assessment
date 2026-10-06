interface BrandLogoProps {
  compact?: boolean;
  className?: string;
}

export function BrandLogo({ compact = false, className }: BrandLogoProps): React.JSX.Element {
  return (
    <img
      className={className}
      src="/assets/highstack-logo.png"
      alt="HighStack"
      width={compact ? 172 : 204}
      height={compact ? 38 : 45}
      decoding="async"
    />
  );
}
