export type BrandIconName = 'email' | 'lock' | 'person' | 'logout' | 'wallet' | 'close' | 'clock' | 'info' | 'check' | 'alert';

interface BrandIconProps {
  name: BrandIconName;
  size?: number;
  className?: string;
}

const PATHS: Record<BrandIconName, React.ReactNode> = {
  email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4m4-4H9" /></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18m-6 5h.01" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
};

export function BrandIcon({ name, size = 18, className }: BrandIconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
