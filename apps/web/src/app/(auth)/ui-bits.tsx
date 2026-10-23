/** 认证页共享外壳：居中卡片 + 统一错误/提示渲染（M4） */

export function AuthShell({
  title,
  error,
  message,
  children,
  footer,
}: {
  title: string;
  error?: string;
  message?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
      <h1 className="text-center text-2xl font-bold tracking-tight">{title}</h1>
      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {message}
        </p>
      )}
      <div className="rounded-xl border bg-card p-6">{children}</div>
      {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}

export function Field({
  label,
  name,
  type = "text",
  placeholder,
  required = true,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
      />
    </label>
  );
}

export function SubmitButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="mt-2 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {label}
    </button>
  );
}
