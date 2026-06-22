// @ts-check
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'

// ESLint flat config —— 最小骨架，规范逐条加。
// 结构分两部分：
//   A. 基础设施：让 TS / Vue 文件「能被解析」，本身不启用任何规则
//   B. 你的规范：在最后那个 rules 里，想加哪条加哪条
export default defineConfig(
    // ── A. 基础设施 ──────────────────────────────────────────────
    // 全局忽略（构建产物等不参与检查）
    {
        ignores: ['**/dist/**', '**/*.d.ts'],
    },
    // 让 .ts / .mts 等被解析（只提供 parser + plugin，不带规则）
    // 注意：base 是单个 config 对象，不能用 ... 展开
    tseslint.configs.base,
    // 让 .vue 被解析
    ...pluginVue.configs['flat/base'],
    // 让 .vue 里的 <script lang="ts"> 用 TS parser
    {
        files: ['**/*.vue'],
        languageOptions: {
            parserOptions: {
                parser: tseslint.parser,
            },
        },
    },
    // ── B. 你的规范：逐条加规则 ───────────────────────────────────
    // 下面每一行就是一条规则。想新增规范，往 rules 里加一行即可。
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts,vue}'],
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            '@stylistic/semi': ['warn', 'never'], // 语句末尾不加分号
            '@stylistic/quotes': ['warn', 'single'], // 字符串用单引号
            '@stylistic/indent': ['warn', 4], // 4 空格缩进
            'vue/html-indent': ['warn', 4],
            'vue/component-name-in-template-casing': ['warn', 'PascalCase'],
            // 每行最多 1 个属性：单行写法超过 1 个就报错→自动拆成每行一个；只有 1 个属性时不动
            'vue/max-attributes-per-line': ['warn', {
                singleline: { max: 1 },
                multiline: { max: 1 },
            }],
            // 多行写法时，第一个属性也另起一行（放到标签名下面）
            'vue/first-attribute-linebreak': ['warn', {
                singleline: 'ignore',
                multiline: 'below',
            }],
            // 多行写法时，闭合的 > 单独占一行；单行写法时 > 跟在末尾
            'vue/html-closing-bracket-newline': ['warn', {
                singleline: 'never',
                multiline: 'always',
            }],
            // 元素跨多行时，标签内容（如 保存）也另起一行
            'vue/multiline-html-element-content-newline': 'warn',
        },
    },
)
