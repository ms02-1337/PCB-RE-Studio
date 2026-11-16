import { render } from 'solid-js/web';
import App from './workbench/App';
import './workbench/theme.css';
import './workbench/placement/placement.css';
render(() => <App />, document.getElementById('root')!);
