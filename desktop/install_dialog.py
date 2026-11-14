"""Nonblocking progress and a persistent, explicit installation result."""
import time
from PySide6.QtCore import Qt,Signal
from PySide6.QtWidgets import QDialog,QVBoxLayout,QHBoxLayout,QLabel,QProgressBar,QPushButton

class InstallDialog(QDialog):
    open_app=Signal(str)
    def __init__(self,parent):
        super().__init__(parent);self.setWindowTitle('安装应用');self.setWindowModality(Qt.WindowModality.WindowModal);self.setMinimumWidth(480)
        self.busy=True;self.app_id=None;self.started=time.monotonic()
        layout=QVBoxLayout(self);layout.setSpacing(12)
        self.title=QLabel('正在安装应用');self.title.setStyleSheet('font-size:18px;font-weight:600')
        self.stage=QLabel('正在检查安装包');self.bar=QProgressBar();self.bar.setRange(0,0)
        self.size=QLabel('');self.file=QLabel('');self.file.setWordWrap(True);self.file.setTextFormat(Qt.TextFormat.PlainText)
        for widget in (self.title,self.stage,self.bar,self.size,self.file):layout.addWidget(widget)
        row=QHBoxLayout();row.addStretch();self.open_button=QPushButton('打开应用');self.open_button.hide();self.close_button=QPushButton('完成');self.close_button.setEnabled(False)
        row.addWidget(self.open_button);row.addWidget(self.close_button);layout.addLayout(row)
        self.open_button.clicked.connect(self.launch);self.close_button.clicked.connect(self.accept)
    def update_progress(self,message):
        names={'check':'正在检查安装包','prepare':'正在读取资源','copy':'正在复制程序与资源','commit':'正在提交安装结果'}
        self.stage.setText(names.get(message['phase'],'正在安装应用'));self.file.setText(message.get('file',''))
        done=message.get('done',0);total=message.get('total',0)
        if total:self.bar.setRange(0,1000);self.bar.setValue(min(990,int(done*990/total)))
        self.size.setText((f'{done/1048576:.2f} / {total/1048576:.2f} MiB · ' if total else '')+f'用时 {time.monotonic()-self.started:.1f} 秒')
    def finish(self,app_id,name):
        self.busy=False;self.app_id=app_id;self.title.setText('安装成功');self.stage.setText(name+' 已添加到桌面');self.file.clear();self.bar.setRange(0,1000);self.bar.setValue(1000);self.close_button.setEnabled(True);self.open_button.show()
    def fail(self,message):
        self.busy=False;self.title.setText('安装失败');self.stage.setText('请检查安装包和资源目录后重试');self.file.setText(message);self.bar.setRange(0,1000);self.bar.setValue(0);self.close_button.setEnabled(True)
    def launch(self):self.accept();self.open_app.emit(self.app_id)
    def reject(self):
        if not self.busy:super().reject()
