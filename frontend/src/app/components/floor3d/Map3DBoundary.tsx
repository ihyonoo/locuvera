// 3D 지도 청크를 받지 못했거나 렌더 중 예외가 나면 부모에게 알린다(부모는 2D로 바꾼다).
// 지연 로딩되는 3D 모듈 밖에서 잡아야 하므로 이 파일은 바로 import한다.
import { Component, type ReactNode } from 'react';

type Props = { onError: () => void; children: ReactNode };

export default class Map3DBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
