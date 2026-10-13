import { Component, lazy, Suspense } from 'react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

class ViewLoadBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="deferred-view-status" role="alert">
      <p>Could not open {this.props.label}. Your saved data is kept.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload app</button>
    </div> : this.props.children;
  }
}

/** Keep secondary screens and their CSS out of the opening Pricing view.
 * Reload also recovers an obsolete chunk URL after a deployment. */
export function deferredView<ViewType extends ComponentType<any>>(load: () => Promise<{ default: ViewType }>, label: string) {
  const View = lazy(load);
  return function DeferredView(props: ComponentProps<ViewType>) {
    return <ViewLoadBoundary label={label}><Suspense fallback={<div className="deferred-view-status" role="status">Loading {label}…</div>}>
      <View {...props} />
    </Suspense></ViewLoadBoundary>;
  };
}
