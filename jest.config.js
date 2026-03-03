/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  // ESM 模式：配合 package.json "type": "module"
  // 运行命令：node --experimental-vm-modules node_modules/.bin/jest
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],

  // 关键：将 .js 导入映射到无扩展名路径
  // 源文件中 import '...foo.js' → Jest 解析为 '...foo' → 找到 'foo.ts'
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // 使用单独的测试 tsconfig（module: ESNext，包含 __tests__ 目录）
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
}
