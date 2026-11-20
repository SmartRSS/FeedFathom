export function Icon(props: { class?: string; raw: string }) {
  return (
    <span
      aria-hidden="true"
      class={`icon ${props.class ?? ""}`}
      innerHTML={props.raw}
    />
  );
}
