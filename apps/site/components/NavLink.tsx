/**
 * Nav link with an underline that wipes in from the left on hover/focus.
 *
 * A transform on a pseudo-element rather than an animated `width` or
 * `border-bottom`, so it composites on the GPU and never triggers layout —
 * the nav is sticky over a live WebGL canvas, and anything that forces a
 * relayout there is felt as a hitch in the scene.
 */
export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="focus-ring group relative hidden py-1 transition-colors duration-300 hover:text-fg sm:inline-block"
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-mesh transition-transform duration-300 ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100"
      />
    </a>
  );
}
