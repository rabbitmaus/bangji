import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Icon } from '@phosphor-icons/react';

export function UiIcon({ icon: I, size = 16 }: { icon: Icon; size?: 14 | 16 | 18 | 20 }) {
  return <I aria-hidden="true" focusable="false" size={size} weight="regular" />;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'neutral' | 'primary' | 'ghost' | 'danger';
  icon?: Icon;
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  tone = 'neutral', icon, className, children, type = 'button',
  loading = false, loadingLabel, disabled, ...rest
}: ButtonProps) {
  const cls = ['btn', tone !== 'neutral' && `btn-${tone}`, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest} disabled={disabled || loading} aria-busy={loading || rest['aria-busy']}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon && <UiIcon icon={icon} />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  selected,
  className,
  type = 'button',
  ...rest
}: { icon: Icon; label: string; selected?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={['ui-icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      data-selected={selected || undefined}
      aria-pressed={selected}
      {...rest}
    >
      <UiIcon icon={icon} />
    </button>
  );
}

export function StatusBar({ children }: { children: ReactNode }) {
  return <footer className="statusbar">{children}</footer>;
}
