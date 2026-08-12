/**
 * 简单的计数器工具函数
 * 为按钮元素绑定点击计数功能（Vite 模板示例代码）
 *
 * @param element - 需要绑定计数器的按钮元素
 */
export function setupCounter(element: HTMLButtonElement) {
  let counter = 0
  // 更新计数器的显示
  const setCounter = (count: number) => {
    counter = count
    element.innerHTML = `Count is ${counter}`
  }
  // 绑定点击事件：每次点击计数 +1
  element.addEventListener('click', () => setCounter(counter + 1))
  // 初始化计数器为 0
  setCounter(0)
}
