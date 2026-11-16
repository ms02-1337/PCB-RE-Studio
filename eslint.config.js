import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['dist/**', 'node_modules/**', 'src-tauri/target/**', 'src-tauri/gen/**'] }, js.configs.recommended, ...ts.configs.recommended, { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } });
