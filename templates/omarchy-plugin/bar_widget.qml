import QtQuick
import qs.Ui

// A bar icon. Add a panel.qml and load it with a Loader (see other plugins)
// when it needs to open something.
BarWidget {
  id: root
  moduleName: "{{user}}.{{id}}"

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf013" // gear; change to the icon you want
    tooltipText: "{{name_json}}"

    onPressed: function(b) {
      if (b === Qt.LeftButton) console.log("{{name_json}}: clicked")
    }
  }
}
