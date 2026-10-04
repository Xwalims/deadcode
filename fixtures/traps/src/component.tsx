export function Button(props: { label: string }) {
  return <button type="button">{props.label}</button>;
}

export function Unused() {
  return <span>nope</span>;
}
