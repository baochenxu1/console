import FaceRigBindingInspector from "../../components/FaceRigBindingInspector.jsx"

/** SDK 入口：与原检视器等价，宿主通过 onBindingsReplace 衔接 {@link ../binding/bindingActions} 或 BindingEngine */
export default function FaceBindingInspector(props) {
  return <FaceRigBindingInspector {...props} />
}
