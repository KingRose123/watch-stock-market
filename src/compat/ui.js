/**
 * wx.showToast / showLoading / showModal 的宿主无关实现。
 *
 * 业务逻辑里这些调用是「发出去就不管」的（41 处 showToast、24 处 showModal），
 * 所以这里做成「事件 + 订阅」：兼容层只负责 emit，真正的 UI 由 <UiHost/> 渲染。
 * 好处是 utils/ 那一整套逻辑（util.submit / util.onError…）完全不用知道 React 存在，
 * 也能在 Node 里直接跑测试。
 */

let state = {
  toast: null, // { id, title, icon, duration }
  loading: null, // { title }
  modal: null, // { id, title, content, confirmText, cancelText, editable, placeholderText, resolve }
  actionSheet: null // { id, itemList, resolve }
}

const listeners = new Set()
let seq = 0

function getState() {
  return state
}

function subscribe(fn) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

function emit(patch) {
  state = Object.assign({}, state, patch)
  listeners.forEach((fn) => {
    try {
      fn(state)
    } catch (e) {
      console.warn('[ui] 渲染回调出错', e && e.message)
    }
  })
}

/* ---------------- Toast ---------------- */

function toast(opts) {
  const o = typeof opts === 'string' ? { title: opts } : opts || {}
  const id = ++seq
  emit({ toast: { id: id, title: String(o.title || ''), icon: o.icon || 'none', duration: o.duration || 1500 } })

  // 自动消失；期间又来了新 toast 就由新的接管（id 不同即视为已过期）
  setTimeout(() => {
    if (state.toast && state.toast.id === id) emit({ toast: null })
  }, o.duration || 1500)
}

/* ---------------- Loading ---------------- */

function loading(title) {
  emit({ loading: { title: String(title || '加载中') } })
}

function hideLoading() {
  if (state.loading) emit({ loading: null })
}

/* ---------------- Modal ---------------- */

/**
 * 支持 wx.showModal 的两种用法：success 回调 和 await 返回值。
 *
 * editable 时多一个输入框，三个配套参数：
 *   placeholderText 提示语；
 *   maxLength       字数上限（默认 50，兑换码那种短输入用得上）；
 *   multiline       多行。写心得体悟这类长文本必须开，单行框只能看见一行，
 *                   写的人不知道自己写了多少；
 *   initialContent  预填值（编辑已有心得时用）。
 *
 * 注意 success 回调拿到的 content 是**用户实际输入的原文**；文字净化
 * 由渲染层（UiHost）按 maxLength 做，业务侧不必再截一次。
 */
function modal(opts) {
  const o = opts || {}
  const id = ++seq

  return new Promise((resolve) => {
    emit({
      modal: {
        id: id,
        title: String(o.title || '提示'),
        content: String(o.content || ''),
        confirmText: String(o.confirmText || '确定'),
        cancelText: o.showCancel === false ? '' : String(o.cancelText || '取消'),
        editable: !!o.editable,
        multiline: !!o.multiline,
        maxLength: Number(o.maxLength) > 0 ? Number(o.maxLength) : 50,
        initialContent: String(o.initialContent || ''),
        placeholderText: String(o.placeholderText || ''),
        // 正文字对齐。默认居中 —— 短问句（"确定删除吗？"）居中最好看。
        // 一段四五行的说明则要传 'left'，否则每行起点不同，读起来眼睛要来回找。
        // 纯粹是渲染提示，不参与任何业务判断。
        align: o.align === 'left' ? 'left' : 'center',
        resolve: (result) => {
          emit({ modal: null })
          if (typeof o.success === 'function') o.success(result)
          resolve(result)
        }
      }
    })
  })
}

/** 关闭当前 modal（组件卸载等场景，避免它一直挂着）*/
function closeModal() {
  if (state.modal) {
    const m = state.modal
    emit({ modal: null })
    if (m.resolve) m.resolve({ confirm: false, cancel: true })
  }
}

/* ---------------- ActionSheet ---------------- */

/**
 * 底部弹出的选项列表（wx.showActionSheet）。
 *
 * 与 modal 的区别不只是弹出位置：modal 问的是「要不要做某事」（两三个按钮、
 * 其中一个是取消），actionSheet 是「从若干项里挑一项」（点中即生效、不需要二次确认）。
 * 所以它没有 cancelText 的概念 —— 取消是点空白或点底部那条"取消"。
 *
 * 回调用法与微信一致：选中走 success({ tapIndex })，取消走 fail({ cancel: true })。
 * Archive 的排序选择器就是唯一的使用方。
 */
function actionSheet(opts) {
  const o = opts || {}
  const id = ++seq
  const items = (o.itemList || []).map((t) => String(t))

  if (!items.length) {
    // 没有选项就没什么可挑的。直接按"取消"回调，避免弹出一个空面板
    if (typeof o.fail === 'function') o.fail({ cancel: true })
    return Promise.resolve({ cancel: true })
  }

  return new Promise((resolve) => {
    emit({
      actionSheet: {
        id: id,
        itemList: items,
        resolve: (res) => {
          emit({ actionSheet: null })
          if (typeof o.success === 'function' && res && !res.cancel) o.success(res)
          if (typeof o.fail === 'function' && res && res.cancel) o.fail(res)
          resolve(res)
        }
      }
    })
  })
}

/** 关闭当前 actionSheet（组件卸载等场景）*/
function closeActionSheet() {
  if (state.actionSheet) {
    const a = state.actionSheet
    emit({ actionSheet: null })
    if (a.resolve) a.resolve({ cancel: true })
  }
}

module.exports = {
  getState,
  subscribe,
  toast,
  loading,
  hideLoading,
  modal,
  closeModal,
  actionSheet,
  closeActionSheet
}
