const React = require('react')
const { View, Text, Modal, ActivityIndicator, StyleSheet, Pressable, TextInput } = require('react-native')
const ui = require('../compat/ui.js')
const validate = require('../utils/validate.js')
const { colors } = require('../theme.js')

/**
 * Toast / Loading / Modal / ActionSheet 的渲染层。
 *
 * 兼容层只负责发事件（wx.showToast 等），这里订阅并画出来。
 * 好处是 utils/ 那一整套逻辑完全不用知道 React 存在，也能在 Node 里跑测试。
 * 界面风格沿用小程序那份的暗色 Toast + 居中卡片。
 */
class UiHost extends React.Component {
  constructor(props) {
    super(props)
    this.state = { ui: ui.getState(), input: '' }
  }

  componentDidMount() {
    this._un = ui.subscribe((s) => {
      const patch = { ui: s }
      // 换了新弹窗就预填输入框：编辑已有心得时必须先看到原文，
      // 否则一打开是空白，用户改一个字就等于把原来那段全抹了。
      const m = s.modal
      if (m && m.id !== this._modalId) {
        this._modalId = m.id
        patch.input = String(m.initialContent || '')
      } else if (!m) {
        this._modalId = 0
      }
      this.setState(patch)
    })
  }

  componentWillUnmount() {
    if (this._un) this._un()
  }

  resolve(confirm) {
    const m = this.state.ui.modal
    // 先读出值、再清空：setState 不会立刻改 this.state，
    // 这里正是靠「读到的是清空前的值」，所以两行顺序不能反。
    const value = this.state.input
    this.setState({ input: '' })
    if (m && m.resolve) m.resolve({ confirm: !!confirm, cancel: !confirm, content: value })
  }

  /** 选中 actionSheet 的第 i 项 */
  pickSheet(i) {
    const a = this.state.ui.actionSheet
    if (a && a.resolve) a.resolve({ tapIndex: i })
  }

  /** 取消 actionSheet：点空白处、点底部取消条、或按返回键都会走到这里 */
  cancelSheet() {
    const a = this.state.ui.actionSheet
    if (a && a.resolve) a.resolve({ cancel: true })
  }

  render() {
    const { toast, loading, modal, actionSheet } = this.state.ui
    // 字数按**码点**数，与 plain/clip 的限长口径一致（否则 emoji 会被算成两个）
    const inputLen = modal && modal.editable ? Array.from(this.state.input).length : 0

    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {loading ? (
          <View style={styles.mask}>
            <View style={styles.loadingBox}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.loadingText}>{loading.title}</Text>
            </View>
          </View>
        ) : null}

        {toast ? (
          <View pointerEvents="none" style={styles.toastWrap}>
            <View style={styles.toastBox}>
              <Text style={styles.toastText}>{toast.title}</Text>
            </View>
          </View>
        ) : null}

        <Modal
          visible={!!modal}
          transparent
          animationType="fade"
          onRequestClose={() => this.resolve(false)}
        >
          <View style={styles.mask}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>{modal ? modal.title : ''}</Text>
              {modal && modal.content ? (
                <Text
                  style={[
                    styles.modalContent,
                    modal.align === 'left' ? styles.modalContentLeft : null
                  ]}
                >
                  {modal.content}
                </Text>
              ) : null}

              {modal && modal.editable ? (
                <TextInput
                  style={[styles.modalInput, modal.multiline ? styles.modalInputMulti : null]}
                  value={this.state.input}
                  onChangeText={(v) =>
                    this.setState({
                      input: validate.plain(v, { max: modal.maxLength, multiline: modal.multiline })
                    })
                  }
                  placeholder={modal.placeholderText}
                  placeholderTextColor="#9AA3A0"
                  autoFocus
                  multiline={modal.multiline}
                  textAlignVertical={modal.multiline ? 'top' : 'center'}
                />
              ) : null}

              {/* 字数只在快到上限时才显示：写短评时它只是噪音，
                  而写长文时又能说清「还有多少余地」，免得对着打不进去发懵 */}
              {modal && modal.editable && modal.multiline && inputLen >= modal.maxLength * 0.8 ? (
                <Text style={styles.modalCount}>
                  {inputLen} / {modal.maxLength}
                </Text>
              ) : null}

              <View style={styles.modalBtns}>
                {/* 次操作在左、主操作在右（国内阅读顺序里"靠右的那颗"更容易被当成主操作）。
                    没有 cancelText 时只剩主按钮，它 flex:1 会自然占满整行 */}
                {modal && modal.cancelText ? (
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnGhost]}
                    onPress={() => this.resolve(false)}
                  >
                    <Text style={styles.modalCancel}>{modal.cancelText}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnPrimary]}
                  onPress={() => this.resolve(true)}
                >
                  <Text style={styles.modalConfirm}>{modal ? modal.confirmText : '确定'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 底部选项列表（wx.showActionSheet）。
            用 slide 而不是 fade：它是从屏幕下沿升上来的，滑入符合空间直觉，
            而淡入会让人以为它是凭空出现在底部 */}
        <Modal
          visible={!!actionSheet}
          transparent
          animationType="slide"
          onRequestClose={() => this.cancelSheet()}
        >
          {/* 必须包一层箭头函数：class 方法不会自动 bind，
              直接传 this.cancelSheet 的话 onPress 触发时 this 是 undefined */}
          <Pressable style={styles.sheetMask} onPress={() => this.cancelSheet()}>
            <View style={styles.sheetWrap}>
              {actionSheet && actionSheet.itemList.length ? (
                <View style={styles.sheetBox}>
                  {actionSheet.itemList.map((label, i) => (
                    <Pressable
                      key={i}
                      style={[styles.sheetItem, i ? styles.sheetItemLine : null]}
                      onPress={() => this.pickSheet(i)}
                    >
                      <Text style={styles.sheetText}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {/* 「取消」单独成块、与选项之间留缝 —— 这是 iOS 的做法，
                  让"放弃"和"选了某一项"在视觉上就分属两件事 */}
              <Pressable style={styles.sheetCancel} onPress={() => this.cancelSheet()}>
                <Text style={styles.sheetCancelText}>取消</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  loadingBox: {
    minWidth: 160,
    paddingHorizontal: 28,
    paddingVertical: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center'
  },
  loadingText: { color: '#FFFFFF', marginTop: 12, fontSize: 14 },
  toastWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toastBox: {
    maxWidth: '80%',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.8)'
  },
  toastText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center' },
  modalBox: {
    width: '84%',
    maxWidth: 340,
    paddingTop: 26,
    paddingBottom: 20,
    paddingHorizontal: 22,
    borderRadius: 20,
    backgroundColor: colors.card
  },
  modalTitle: { fontSize: 17, fontWeight: '600', color: colors.t1, textAlign: 'center' },
  modalContent: {
    marginTop: 12,
    fontSize: 14.5,
    lineHeight: 22,
    color: colors.t2,
    textAlign: 'center'
  },
  /**
   * 长文案用左对齐。
   *
   * 短问句（"确定删除吗？"）居中最好看，但一段四五行的说明居中排下来
   * 每一行的起点都不一样，眼睛要来回找 —— 那种长度下左对齐才读得下去。
   * 由调用方通过 wx.showModal({ align: 'left' }) 指定，默认仍是居中，
   * 所以已有的弹窗不会有任何变化。
   */
  modalContentLeft: { textAlign: 'left' },
  modalInput: {
    marginTop: 18,
    marginHorizontal: 24,
    paddingHorizontal: 14,
    height: 46,
    borderRadius: 10,
    backgroundColor: '#F4F6F5',
    fontSize: 16,
    color: '#1F1F1F'
  },
  // 多行：给足高度并顶部对齐，否则光标会飘在中间（与 AddTrade 的备注框同一处理）。
  // 这是写心得体悟的地方，按「能写长文」给高度，不是只露两行。
  modalInputMulti: { height: 150, paddingTop: 12, paddingBottom: 12, lineHeight: 21 },
  modalCount: {
    marginTop: 6,
    marginHorizontal: 24,
    fontSize: 11,
    textAlign: 'right',
    color: '#9AA3A0'
  },
  /**
   * 按钮区。
   *
   * 原来是「一条上分割线 + 两个等宽纯文字」，那是 Android 原生 AlertDialog
   * 的样子 —— 问题是两个按钮视觉权重完全一样，用户看不出哪个是主操作。
   * 而这里的弹窗多半是「去续费 / 知道了」这类一问一答，主次必须一眼可辨。
   *
   * 改成：主操作实心色块、次操作浅灰底，两个都是圆角矩形。
   * 不加分割线 —— 圆角块自己就有边界，再压一条线只会显脏。
   */
  modalBtns: { flexDirection: 'row', marginTop: 22 },
  modalBtn: {
    flex: 1,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // 次按钮留出与主按钮的间距。不用 gap 是因为它要 RN 0.71+，
  // 而 marginRight 在任何版本上都成立。
  modalBtnGhost: { backgroundColor: colors.line2, marginRight: 10 },
  modalBtnPrimary: { backgroundColor: colors.accent },
  modalCancel: { fontSize: 15.5, fontWeight: '500', color: colors.t2 },
  modalConfirm: { fontSize: 15.5, fontWeight: '600', color: '#FFFFFF' },

  /* ---------- ActionSheet ---------- */
  // 内容贴屏幕下沿，所以用 flex-end（modal 那种是居中）
  sheetMask: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  sheetWrap: { paddingHorizontal: 10, paddingBottom: 14 },
  sheetBox: { borderRadius: 14, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  sheetItem: { paddingVertical: 16, alignItems: 'center' },
  sheetItemLine: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E6EAE8'
  },
  // 选项文字用主色：它是"可执行的动作"，
  // 而"取消"用灰色 —— 一眼就能分出哪一组是能选的
  sheetText: { fontSize: 16, color: colors.accent },
  // 取消块与选项之间留一道缝，让它看起来是独立的一块，
  // 而不是选项列表的最后一项（iOS 的 actionSheet 就是这么分的）
  sheetCancel: {
    marginTop: 8,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    alignItems: 'center'
  },
  sheetCancelText: { fontSize: 16, fontWeight: '600', color: '#8A9391' }
})

module.exports = UiHost
