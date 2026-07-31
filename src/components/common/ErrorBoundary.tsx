import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { logError } from '../../lib/logger'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * React 错误边界组件
 *
 * 捕获子组件树中的渲染异常，防止整个应用白屏。
 * 捕获到的错误通过 logError 记录（测试/开发模式下输出到终端）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    logError('ErrorBoundary:render', error)
    if (info.componentStack) {
      logError('ErrorBoundary:componentStack', info.componentStack)
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-tavern-bg text-tavern-text px-4 animate-fade-in">
          <div className="max-w-md w-full rounded-2xl bg-tavern-bg-card border border-tavern-border p-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-tavern-danger/20 flex items-center justify-center mx-auto mb-4 text-tavern-danger">
              <AlertTriangle size={24} />
            </div>
            <h2 className="text-lg font-medium mb-2">页面渲染异常</h2>
            <p className="text-sm text-tavern-text-muted mb-1">
              应用遇到了一个渲染错误，已自动捕获并记录。
            </p>
            {this.state.error && (
              <p className="text-xs text-tavern-text-soft font-mono mb-4 break-all">
                {this.state.error.message}
              </p>
            )}
            <button className="btn-primary inline-flex items-center gap-2 mt-2" onClick={this.handleReset}>
              <RefreshCw size={16} />
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
