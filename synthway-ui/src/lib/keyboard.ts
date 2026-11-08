import { useEffect, useRef } from 'react';

/** A field the user types in: its keys are its own (a checkbox, a slider or a button is not one) */
export function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button'].includes(target.type);
  }
  return target instanceof HTMLElement && (target.isContentEditable || ['SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * The space bar calls onSpace (play/pause on a screen that plays something)
 * instead of scrolling the page, anywhere but in a field the user types in.
 * It also takes the space bar from a focused button, which a mouse click
 * leaves focused: pressing it would click the button again. A component that
 * handles the space bar itself calls preventDefault, and keeps it. A key held
 * down calls onSpace once. onSpace can change at each render.
 */
export function useSpaceBar(onSpace: () => void): void {
  const onSpaceRef = useRef(onSpace);
  onSpaceRef.current = onSpace;

  useEffect(() => {
    let pressed = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isTyping(event.target)) return;
      event.preventDefault();
      if (event.repeat) return;
      pressed = true;
      onSpaceRef.current();
    };
    // A button clicks on the release of the space bar
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !pressed) return;
      pressed = false;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}
