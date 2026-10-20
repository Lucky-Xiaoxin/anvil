/**
 * 全局错误边界（docs/prompts/19 §2.5）：任何一次渲染期抛错都不该把整棵树卸成白屏。
 * 只兜渲染；事件回调 / 异步里的错误照旧各自处理（那些抛不出来把这棵树炸掉）。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './components/ui.tsx';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[anvil] 渲染出错：', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 640 }}>
        <div className="alert alert--err" role="alert">
          <Icon id="i-x" />
          <div>
            <b>这屏画不出来</b> · {this.state.error.message}
          </div>
        </div>
        <p className="hint" style={{ margin: '10px 0' }}>
          数据在 <code>vault/</code> 里，不受影响 —— 重新加载通常会好；还不行就重开一次服务。
        </p>
        <button className="btn btn--sm" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}