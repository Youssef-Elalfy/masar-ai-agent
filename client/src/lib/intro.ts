/** Resolves when the brand intro has finished (or immediately if it does not play), so heavy work waits for it. */
let resolveIntro: () => void = () => undefined;
const done = new Promise<void>((resolve) => {
  resolveIntro = resolve;
});

export function markIntroFinished(): void {
  resolveIntro();
}

export function introFinished(): Promise<void> {
  return done;
}
