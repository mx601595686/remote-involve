"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MessageType_1 = require("../interfaces/MessageType");
const MessageData_1 = require("./MessageData");
const MessageRouting_1 = require("./MessageRouting");
class RemoteInvoke extends MessageRouting_1.MessageRouting {
    /**
     * @param socket 连接端口
     * @param moduleName 当前模块的名称
     */
    constructor(socket, moduleName) {
        if (socket.ri != null)
            throw new Error('传入的ConnectionSocket已在其他地方被使用');
        super(socket, moduleName);
        this._socket.ri = this;
    }
    /**
     * 对外导出方法。
     * 如果要向调用方反馈错误，直接 throw new Error() 即可。
     * 注意：对于导出方法，当它执行完成，返回结果后就不可以再继续下载文件了。
     * 注意：一个path上只允许导出一个方法。如果重复导出则后面的应该覆盖掉前面的。
     * @param path 所导出的路径
     * @param func 导出的方法
     */
    export(path, func) {
        this.cancelExport(path);
        this._messageListener.receive([MessageType_1.MessageType.invoke_request, path], async (msg) => {
            const { data, clean } = this._prepare_InvokeReceivingData(msg);
            try {
                const result = await func(data) || { data: null };
                this._send_InvokeResponseMessage(msg, result);
            }
            catch (error) {
                this._send_InvokeFailedMessage(msg, error);
            }
            finally {
                clean();
            }
        });
        return func;
    }
    /**
     * 取消对外导出的方法
     * @param path 之前导出的路径
     */
    cancelExport(path) {
        this._messageListener.cancel([MessageType_1.MessageType.invoke_request, path]);
    }
    invoke(receiver, path, data = { data: null }, callback) {
        if (callback) {
            this._send_InvokeRequestMessage(receiver, path, data).then(msg => {
                const { data, clean } = this._prepare_InvokeReceivingData(msg);
                callback(undefined, data).then(() => {
                    clean();
                    this._send_InvokeFinishMessage(msg);
                }).catch(err => {
                    clean();
                    this._send_InvokeFinishMessage(msg);
                    throw err;
                });
            }).catch(callback);
        }
        else {
            return (async () => {
                const msg = await this._send_InvokeRequestMessage(receiver, path, data);
                const { data: r_data, clean } = this._prepare_InvokeReceivingData(msg);
                try {
                    const result = [];
                    for (const item of r_data.files) {
                        result.push({ name: item.name, data: await item.getFile() });
                    }
                    return { data: r_data.data, files: result };
                }
                catch (error) {
                    throw error;
                }
                finally {
                    clean();
                    this._send_InvokeFinishMessage(msg);
                }
            })();
        }
    }
    /**
     * 注册广播监听器
     * @param sender 发送者
     * @param name 广播的路径
     * @param func 对应的回调方法
     */
    receive(sender, path, func) {
        const eventName = [MessageType_1.MessageType.broadcast, sender, ...path.split('.')];
        if (!this._messageListener.has(eventName)) {
            this._send_BroadcastOpenMessage(sender, path);
        }
        this._messageListener.receive(eventName, func); //不包装一下监听器，是为了考虑到cancelReceive
        return func;
    }
    /**
     * 删除指定路径上的所有广播监听器，可以传递一个listener来只删除一个特定的监听器
     * @param sender 发送者
     * @param name 广播的路径
     * @param listener 要指定删除的监听器
     */
    cancelReceive(sender, path, listener) {
        const eventName = [MessageType_1.MessageType.broadcast, sender, ...path.split('.')];
        if (this._messageListener.has(eventName)) {
            this._messageListener.cancel(eventName, listener);
            if (!this._messageListener.has(eventName)) {
                this._send_BroadcastCloseMessage(sender, path);
            }
        }
    }
    /**
     * 对外广播数据
     * @param path 广播的路径
     * @param data 要发送的数据
     */
    broadcast(path, data = null) {
        this._send_BroadcastMessage(path, data);
    }
    /**
     * 准备好下载回调。返回InvokeReceivingData与清理资源回调
     */
    _prepare_InvokeReceivingData(msg) {
        const messageID = msg instanceof MessageData_1.InvokeRequestMessage ? msg.requestMessageID : msg.responseMessageID;
        let cleaned = false; //是否下载已被清理
        const files = msg.files.map(item => {
            let start = false; //是否已经开始获取了，主要是用于防止重复下载
            let index = -1; //现在接收到第几个文件片段了
            let downloadedSize = 0; //已下载大小
            const downloadNext = () => {
                if (cleaned)
                    return Promise.reject(new Error('下载终止'));
                index++;
                if (item.splitNumber != null && index >= item.splitNumber) {
                    return Promise.resolve();
                }
                else {
                    return this._send_InvokeFileRequestMessage(msg, item.id, index).then(data => {
                        if (data && item.size != null && (downloadedSize += data.length) > item.size)
                            throw new Error('下载到的文件大小超出了发送者所描述的大小');
                        return data;
                    });
                }
            };
            const result = {
                size: item.size,
                splitNumber: item.splitNumber,
                name: item.name,
                onData: async (callback, startIndex = 0) => {
                    if (start) {
                        callback(new Error('不可重复下载文件'));
                    }
                    else {
                        start = true;
                        index = startIndex - 1;
                        while (true) {
                            try {
                                var data = await downloadNext();
                            }
                            catch (error) {
                                callback(error);
                                break;
                            }
                            if (data) {
                                const isNext = await callback(undefined, false, index, data);
                                if (isNext === true)
                                    break;
                            }
                            else {
                                callback(undefined, true, index, Buffer.alloc(0));
                                break;
                            }
                        }
                    }
                },
                getFile: async () => {
                    if (start) {
                        throw new Error('不可重复下载文件');
                    }
                    else {
                        start = true;
                        const filePieces = []; //下载到的文件片段
                        while (true) {
                            const data = await downloadNext();
                            if (data) {
                                filePieces.push(data);
                            }
                            else {
                                return Buffer.concat(filePieces);
                            }
                        }
                    }
                }
            };
            return result;
        });
        return {
            data: { data: msg.data, files },
            clean: () => {
                cleaned = true;
                this._messageListener.triggerDescendants([MessageType_1.MessageType.invoke_file_failed, msg.sender, messageID], { error: '下载终止' });
            }
        };
    }
}
exports.RemoteInvoke = RemoteInvoke;

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNsYXNzZXMvUmVtb3RlSW52b2tlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsMkRBQXdEO0FBSXhELCtDQUE0RTtBQUM1RSxxREFBa0Q7QUFFbEQsa0JBQTBCLFNBQVEsK0JBQWM7SUFFNUM7OztPQUdHO0lBQ0gsWUFBWSxNQUF3QixFQUFFLFVBQWtCO1FBQ3BELEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksSUFBSSxDQUFDO1lBQ2xCLE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLENBQUMsQ0FBQztRQUVwRCxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBRTFCLElBQUksQ0FBQyxPQUFPLENBQUMsRUFBRSxHQUFHLElBQUksQ0FBQztJQUMzQixDQUFDO0lBRUQ7Ozs7Ozs7T0FPRztJQUNILE1BQU0sQ0FBNkUsSUFBWSxFQUFFLElBQU87UUFDcEcsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4QixJQUFJLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxDQUFDLENBQUMseUJBQVcsQ0FBQyxjQUFjLEVBQUUsSUFBSSxDQUFRLEVBQUUsS0FBSyxFQUFFLEdBQXlCO1lBQ3JHLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEdBQUcsSUFBSSxDQUFDLDRCQUE0QixDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBRS9ELElBQUksQ0FBQztnQkFDRCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQztnQkFDbEQsSUFBSSxDQUFDLDJCQUEyQixDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsQ0FBQztZQUNsRCxDQUFDO1lBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztnQkFDYixJQUFJLENBQUMseUJBQXlCLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQy9DLENBQUM7b0JB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QUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7d0JBQ1IsTUFBTSxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztvQkFDaEMsQ0FBQztvQkFBQyxJQUFJLENBQUMsQ0FBQzt3QkFDSixLQUFLLEdBQUcsSUFBSSxDQUFDO3dCQUNiLE1BQU0sVUFBVSxHQUFhLEVBQUUsQ0FBQyxDQUFJLFVBQVU7d0JBRTlDLE9BQU8sSUFBSSxFQUFFLENBQUM7NEJBQ1YsTUFBTSxJQUFJLEdBQUcsTUFBTSxZQUFZLEVBQUUsQ0FBQzs0QkFFbEMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztnQ0FDUCxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDOzRCQUMxQixDQUFDOzRCQUFDLElBQUksQ0FBQyxDQUFDO2dDQUNKLE1BQU0sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDOzRCQUNyQyxDQUFDO3dCQUNMLENBQUM7b0JBQ0wsQ0FBQztnQkFDTCxDQUFDO2FBQ0osQ0FBQTtZQUVELE1BQU0sQ0FBQyxNQUFNLENBQUM7UUFDbEIsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLENBQUM7WUFDSCxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsR0FBRyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDL0IsS0FBSyxFQUFFO2dCQUNILE9BQU8sR0FBRyxJQUFJLENBQUM7Z0JBQ2YsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGtCQUFrQixDQUFDLENBQUMseUJBQVcsQ0FBQyxrQkFBa0IsRUFBRSxHQUFHLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBUSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFDaEksQ0FBQztTQUNKLENBQUM7SUFDTixDQUFDO0NBQ0o7QUExT0Qsb0NBME9DIiwiZmlsZSI6ImNsYXNzZXMvUmVtb3RlSW52b2tlLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgTWVzc2FnZVR5cGUgfSBmcm9tICcuLi9pbnRlcmZhY2VzL01lc3NhZ2VUeXBlJztcclxuaW1wb3J0IHsgQ29ubmVjdGlvblNvY2tldCB9IGZyb20gXCIuLi9pbnRlcmZhY2VzL0Nvbm5lY3Rpb25Tb2NrZXRcIjtcclxuaW1wb3J0IHsgSW52b2tlUmVjZWl2aW5nRGF0YSwgUmVjZWl2aW5nRmlsZSB9IGZyb20gJy4uL2ludGVyZmFjZXMvSW52b2tlUmVjZWl2aW5nRGF0YSc7XHJcbmltcG9ydCB7IEludm9rZVNlbmRpbmdEYXRhIH0gZnJvbSAnLi4vaW50ZXJmYWNlcy9JbnZva2VTZW5kaW5nRGF0YSc7XHJcbmltcG9ydCB7IEludm9rZVJlcXVlc3RNZXNzYWdlLCBJbnZva2VSZXNwb25zZU1lc3NhZ2UgfSBmcm9tICcuL01lc3NhZ2VEYXRhJztcclxuaW1wb3J0IHsgTWVzc2FnZVJvdXRpbmcgfSBmcm9tICcuL01lc3NhZ2VSb3V0aW5nJztcclxuXHJcbmV4cG9ydCBjbGFzcyBSZW1vdGVJbnZva2UgZXh0ZW5kcyBNZXNzYWdlUm91dGluZyB7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBAcGFyYW0gc29ja2V0IOi/nuaOpeerr+WPo1xyXG4gICAgICogQHBhcmFtIG1vZHVsZU5hbWUg5b2T5YmN5qih5Z2X55qE5ZCN56ewXHJcbiAgICAgKi9cclxuICAgIGNvbnN0cnVjdG9yKHNvY2tldDogQ29ubmVjdGlvblNvY2tldCwgbW9kdWxlTmFtZTogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKHNvY2tldC5yaSAhPSBudWxsKVxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S8oOWFpeeahENvbm5lY3Rpb25Tb2NrZXTlt7LlnKjlhbbku5blnLDmlrnooqvkvb/nlKgnKTtcclxuXHJcbiAgICAgICAgc3VwZXIoc29ja2V0LCBtb2R1bGVOYW1lKTtcclxuXHJcbiAgICAgICAgdGhpcy5fc29ja2V0LnJpID0gdGhpcztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWvueWkluWvvOWHuuaWueazleOAgiAgICAgXHJcbiAgICAgKiDlpoLmnpzopoHlkJHosIPnlKjmlrnlj43ppojplJnor6/vvIznm7TmjqUgdGhyb3cgbmV3IEVycm9yKCkg5Y2z5Y+v44CCICAgICBcclxuICAgICAqIOazqOaEj++8muWvueS6juWvvOWHuuaWueazle+8jOW9k+Wug+aJp+ihjOWujOaIkO+8jOi/lOWbnue7k+aenOWQjuWwseS4jeWPr+S7peWGjee7p+e7reS4i+i9veaWh+S7tuS6huOAgiAgICAgXHJcbiAgICAgKiDms6jmhI/vvJrkuIDkuKpwYXRo5LiK5Y+q5YWB6K645a+85Ye65LiA5Liq5pa55rOV44CC5aaC5p6c6YeN5aSN5a+85Ye65YiZ5ZCO6Z2i55qE5bqU6K+l6KaG55uW5o6J5YmN6Z2i55qE44CCICAgICBcclxuICAgICAqIEBwYXJhbSBwYXRoIOaJgOWvvOWHuueahOi3r+W+hFxyXG4gICAgICogQHBhcmFtIGZ1bmMg5a+85Ye655qE5pa55rOVIFxyXG4gICAgICovXHJcbiAgICBleHBvcnQ8RiBleHRlbmRzIChkYXRhOiBJbnZva2VSZWNlaXZpbmdEYXRhKSA9PiBQcm9taXNlPHZvaWQgfCBJbnZva2VTZW5kaW5nRGF0YT4+KHBhdGg6IHN0cmluZywgZnVuYzogRik6IEYge1xyXG4gICAgICAgIHRoaXMuY2FuY2VsRXhwb3J0KHBhdGgpO1xyXG4gICAgICAgIHRoaXMuX21lc3NhZ2VMaXN0ZW5lci5yZWNlaXZlKFtNZXNzYWdlVHlwZS5pbnZva2VfcmVxdWVzdCwgcGF0aF0gYXMgYW55LCBhc3luYyAobXNnOiBJbnZva2VSZXF1ZXN0TWVzc2FnZSkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCB7IGRhdGEsIGNsZWFuIH0gPSB0aGlzLl9wcmVwYXJlX0ludm9rZVJlY2VpdmluZ0RhdGEobXNnKTtcclxuXHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBmdW5jKGRhdGEpIHx8IHsgZGF0YTogbnVsbCB9O1xyXG4gICAgICAgICAgICAgICAgdGhpcy5fc2VuZF9JbnZva2VSZXNwb25zZU1lc3NhZ2UobXNnLCByZXN1bHQpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5fc2VuZF9JbnZva2VGYWlsZWRNZXNzYWdlKG1zZywgZXJyb3IpO1xyXG4gICAgICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICAgICAgY2xlYW4oKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICByZXR1cm4gZnVuYztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWPlua2iOWvueWkluWvvOWHuueahOaWueazlVxyXG4gICAgICogQHBhcmFtIHBhdGgg5LmL5YmN5a+85Ye655qE6Lev5b6EXHJcbiAgICAgKi9cclxuICAgIGNhbmNlbEV4cG9ydChwYXRoOiBzdHJpbmcpIHtcclxuICAgICAgICB0aGlzLl9tZXNzYWdlTGlzdGVuZXIuY2FuY2VsKFtNZXNzYWdlVHlwZS5pbnZva2VfcmVxdWVzdCwgcGF0aF0gYXMgYW55KTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOiwg+eUqOi/nOerr+aooeWdl+WvvOWHuueahOaWueazleOAgui/lOWbnuaVsOaNruWSjOaJgOacieS4i+i9veWIsOeahOaWh+S7tlxyXG4gICAgICogQHBhcmFtIHJlY2VpdmVyIOi/nOerr+aooeWdl+eahOWQjeensFxyXG4gICAgICogQHBhcmFtIHBhdGgg5pa55rOV55qE6Lev5b6EXHJcbiAgICAgKiBAcGFyYW0gZGF0YSDopoHkvKDpgJLnmoTmlbDmja5cclxuICAgICAqL1xyXG4gICAgaW52b2tlKHJlY2VpdmVyOiBzdHJpbmcsIHBhdGg6IHN0cmluZywgZGF0YT86IEludm9rZVNlbmRpbmdEYXRhKTogUHJvbWlzZTx7IGRhdGE6IGFueSwgZmlsZXM6IHsgbmFtZTogc3RyaW5nLCBkYXRhOiBCdWZmZXIgfVtdIH0+XHJcbiAgICAvKipcclxuICAgICAqIOiwg+eUqOi/nOerr+aooeWdl+WvvOWHuueahOaWueazleOAglxyXG4gICAgICogQHBhcmFtIHJlY2VpdmVyIOi/nOerr+aooeWdl+eahOWQjeensFxyXG4gICAgICogQHBhcmFtIHBhdGgg5pa55rOV55qE6Lev5b6EXHJcbiAgICAgKiBAcGFyYW0gZGF0YSDopoHkvKDpgJLnmoTmlbDmja5cclxuICAgICAqIEBwYXJhbSBjYWxsYmFjayDmjqXmlLblk43lupTnmoTlm57osIPjgILms6jmhI/vvJrkuIDml6blm57osIPmiafooYzlrozmiJDlsLHkuI3og73lho3kuIvovb3mlofku7bkuobjgIJcclxuICAgICAqL1xyXG4gICAgaW52b2tlKHJlY2VpdmVyOiBzdHJpbmcsIHBhdGg6IHN0cmluZywgZGF0YTogSW52b2tlU2VuZGluZ0RhdGEgfCB1bmRlZmluZWQsIGNhbGxiYWNrOiAoZXJyOiBFcnJvciB8IHVuZGVmaW5lZCwgZGF0YTogSW52b2tlUmVjZWl2aW5nRGF0YSkgPT4gUHJvbWlzZTx2b2lkPik6IHZvaWRcclxuICAgIGludm9rZShyZWNlaXZlcjogc3RyaW5nLCBwYXRoOiBzdHJpbmcsIGRhdGE6IEludm9rZVNlbmRpbmdEYXRhID0geyBkYXRhOiBudWxsIH0sIGNhbGxiYWNrPzogKGVycjogRXJyb3IgfCB1bmRlZmluZWQsIGRhdGE6IEludm9rZVJlY2VpdmluZ0RhdGEpID0+IFByb21pc2U8dm9pZD4pOiBhbnkge1xyXG4gICAgICAgIGlmIChjYWxsYmFjaykgeyAgIC8v5Zue6LCD5Ye95pWw54mI5pysXHJcbiAgICAgICAgICAgIHRoaXMuX3NlbmRfSW52b2tlUmVxdWVzdE1lc3NhZ2UocmVjZWl2ZXIsIHBhdGgsIGRhdGEpLnRoZW4obXNnID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgZGF0YSwgY2xlYW4gfSA9IHRoaXMuX3ByZXBhcmVfSW52b2tlUmVjZWl2aW5nRGF0YShtc2cpO1xyXG4gICAgICAgICAgICAgICAgY2FsbGJhY2sodW5kZWZpbmVkLCBkYXRhKS50aGVuKCgpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBjbGVhbigpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NlbmRfSW52b2tlRmluaXNoTWVzc2FnZShtc2cpO1xyXG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZXJyID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBjbGVhbigpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NlbmRfSW52b2tlRmluaXNoTWVzc2FnZShtc2cpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IGVycjtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9KS5jYXRjaChjYWxsYmFjayBhcyBhbnkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHJldHVybiAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbXNnID0gYXdhaXQgdGhpcy5fc2VuZF9JbnZva2VSZXF1ZXN0TWVzc2FnZShyZWNlaXZlciwgcGF0aCwgZGF0YSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IGRhdGE6IHJfZGF0YSwgY2xlYW4gfSA9IHRoaXMuX3ByZXBhcmVfSW52b2tlUmVjZWl2aW5nRGF0YShtc2cpO1xyXG5cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0OiB7IG5hbWU6IHN0cmluZywgZGF0YTogQnVmZmVyIH1bXSA9IFtdO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygcl9kYXRhLmZpbGVzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKHsgbmFtZTogaXRlbS5uYW1lLCBkYXRhOiBhd2FpdCBpdGVtLmdldEZpbGUoKSB9KTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGRhdGE6IHJfZGF0YS5kYXRhLCBmaWxlczogcmVzdWx0IH07XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgICAgICAgICBjbGVhbigpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NlbmRfSW52b2tlRmluaXNoTWVzc2FnZShtc2cpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOazqOWGjOW5v+aSreebkeWQrOWZqCAgICAgIFxyXG4gICAgICogQHBhcmFtIHNlbmRlciDlj5HpgIHogIVcclxuICAgICAqIEBwYXJhbSBuYW1lIOW5v+aSreeahOi3r+W+hFxyXG4gICAgICogQHBhcmFtIGZ1bmMg5a+55bqU55qE5Zue6LCD5pa55rOVXHJcbiAgICAgKi9cclxuICAgIHJlY2VpdmU8RiBleHRlbmRzIChhcmc6IGFueSkgPT4gYW55PihzZW5kZXI6IHN0cmluZywgcGF0aDogc3RyaW5nLCBmdW5jOiBGKTogRiB7XHJcbiAgICAgICAgY29uc3QgZXZlbnROYW1lID0gW01lc3NhZ2VUeXBlLmJyb2FkY2FzdCwgc2VuZGVyLCAuLi5wYXRoLnNwbGl0KCcuJyldIGFzIGFueTtcclxuXHJcbiAgICAgICAgaWYgKCF0aGlzLl9tZXNzYWdlTGlzdGVuZXIuaGFzKGV2ZW50TmFtZSkpIHsgIC8v5aaC5p6c6L+Y5rKh5rOo5YaM6L+H77yM6YCa55+l5a+55pa5546w5Zyo6KaB5o6l5pS25oyH5a6a6Lev5b6E5bm/5pKtXHJcbiAgICAgICAgICAgIHRoaXMuX3NlbmRfQnJvYWRjYXN0T3Blbk1lc3NhZ2Uoc2VuZGVyLCBwYXRoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMuX21lc3NhZ2VMaXN0ZW5lci5yZWNlaXZlKGV2ZW50TmFtZSwgZnVuYyk7IC8v5LiN5YyF6KOF5LiA5LiL55uR5ZCs5Zmo77yM5piv5Li65LqG6ICD6JmR5YiwY2FuY2VsUmVjZWl2ZVxyXG4gICAgICAgIHJldHVybiBmdW5jO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5Yig6Zmk5oyH5a6a6Lev5b6E5LiK55qE5omA5pyJ5bm/5pKt55uR5ZCs5Zmo77yM5Y+v5Lul5Lyg6YCS5LiA5LiqbGlzdGVuZXLmnaXlj6rliKDpmaTkuIDkuKrnibnlrprnmoTnm5HlkKzlmahcclxuICAgICAqIEBwYXJhbSBzZW5kZXIg5Y+R6YCB6ICFXHJcbiAgICAgKiBAcGFyYW0gbmFtZSDlub/mkq3nmoTot6/lvoRcclxuICAgICAqIEBwYXJhbSBsaXN0ZW5lciDopoHmjIflrprliKDpmaTnmoTnm5HlkKzlmahcclxuICAgICAqL1xyXG4gICAgY2FuY2VsUmVjZWl2ZShzZW5kZXI6IHN0cmluZywgcGF0aDogc3RyaW5nLCBsaXN0ZW5lcj86IChhcmc6IGFueSkgPT4gYW55KSB7XHJcbiAgICAgICAgY29uc3QgZXZlbnROYW1lID0gW01lc3NhZ2VUeXBlLmJyb2FkY2FzdCwgc2VuZGVyLCAuLi5wYXRoLnNwbGl0KCcuJyldIGFzIGFueTtcclxuXHJcbiAgICAgICAgaWYgKHRoaXMuX21lc3NhZ2VMaXN0ZW5lci5oYXMoZXZlbnROYW1lKSkgeyAgLy/noa7kv53nnJ/nmoTmnInms6jlhozov4flho3miafooYzliKDpmaRcclxuICAgICAgICAgICAgdGhpcy5fbWVzc2FnZUxpc3RlbmVyLmNhbmNlbChldmVudE5hbWUsIGxpc3RlbmVyKTtcclxuXHJcbiAgICAgICAgICAgIGlmICghdGhpcy5fbWVzc2FnZUxpc3RlbmVyLmhhcyhldmVudE5hbWUpKSB7ICAgIC8v5aaC5p6c5Yig5YWJ5LqG77yM5bCx6YCa55+l5a+55pa55LiN5YaN5o6l5pS25LqGXHJcbiAgICAgICAgICAgICAgICB0aGlzLl9zZW5kX0Jyb2FkY2FzdENsb3NlTWVzc2FnZShzZW5kZXIsIHBhdGgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5a+55aSW5bm/5pKt5pWw5o2uXHJcbiAgICAgKiBAcGFyYW0gcGF0aCDlub/mkq3nmoTot6/lvoRcclxuICAgICAqIEBwYXJhbSBkYXRhIOimgeWPkemAgeeahOaVsOaNrlxyXG4gICAgICovXHJcbiAgICBicm9hZGNhc3QocGF0aDogc3RyaW5nLCBkYXRhOiBhbnkgPSBudWxsKSB7XHJcbiAgICAgICAgdGhpcy5fc2VuZF9Ccm9hZGNhc3RNZXNzYWdlKHBhdGgsIGRhdGEpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5YeG5aSH5aW95LiL6L295Zue6LCD44CC6L+U5ZueSW52b2tlUmVjZWl2aW5nRGF0YeS4jua4heeQhui1hOa6kOWbnuiwg1xyXG4gICAgICovXHJcbiAgICBwcml2YXRlIF9wcmVwYXJlX0ludm9rZVJlY2VpdmluZ0RhdGEobXNnOiBJbnZva2VSZXF1ZXN0TWVzc2FnZSB8IEludm9rZVJlc3BvbnNlTWVzc2FnZSkge1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2VJRCA9IG1zZyBpbnN0YW5jZW9mIEludm9rZVJlcXVlc3RNZXNzYWdlID8gbXNnLnJlcXVlc3RNZXNzYWdlSUQgOiBtc2cucmVzcG9uc2VNZXNzYWdlSUQ7XHJcbiAgICAgICAgbGV0IGNsZWFuZWQgPSBmYWxzZTsgICAvL+aYr+WQpuS4i+i9veW3suiiq+a4heeQhlxyXG5cclxuICAgICAgICBjb25zdCBmaWxlcyA9IG1zZy5maWxlcy5tYXAoaXRlbSA9PiB7XHJcbiAgICAgICAgICAgIGxldCBzdGFydDogYm9vbGVhbiA9IGZhbHNlOyAgICAgICAgICAgICAvL+aYr+WQpuW3sue7j+W8gOWni+iOt+WPluS6hu+8jOS4u+imgeaYr+eUqOS6jumYsuatoumHjeWkjeS4i+i9vVxyXG4gICAgICAgICAgICBsZXQgaW5kZXggPSAtMTsgICAgICAgICAgICAgICAgICAgICAgICAgLy/njrDlnKjmjqXmlLbliLDnrKzlh6DkuKrmlofku7bniYfmrrXkuoZcclxuICAgICAgICAgICAgbGV0IGRvd25sb2FkZWRTaXplID0gMDsgICAgICAgICAgICAgICAgIC8v5bey5LiL6L295aSn5bCPXHJcblxyXG4gICAgICAgICAgICBjb25zdCBkb3dubG9hZE5leHQgPSAoKSA9PiB7ICAgICAgICAgICAgLy/kuIvovb3kuIvkuIDkuKrmlofku7bniYfmrrVcclxuICAgICAgICAgICAgICAgIGlmIChjbGVhbmVkKVxyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoJ+S4i+i9vee7iOatoicpKTtcclxuXHJcbiAgICAgICAgICAgICAgICBpbmRleCsrO1xyXG5cclxuICAgICAgICAgICAgICAgIGlmIChpdGVtLnNwbGl0TnVtYmVyICE9IG51bGwgJiYgaW5kZXggPj0gaXRlbS5zcGxpdE51bWJlcikgeyAgICAvL+WIpOaWreaYr+WQpuS4i+i9veWujOS6hlxyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlbmRfSW52b2tlRmlsZVJlcXVlc3RNZXNzYWdlKG1zZywgaXRlbS5pZCwgaW5kZXgpLnRoZW4oZGF0YSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkYXRhICYmIGl0ZW0uc2l6ZSAhPSBudWxsICYmIChkb3dubG9hZGVkU2l6ZSArPSBkYXRhLmxlbmd0aCkgPiBpdGVtLnNpemUpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S4i+i9veWIsOeahOaWh+S7tuWkp+Wwj+i2heWHuuS6huWPkemAgeiAheaJgOaPj+i/sOeahOWkp+WwjycpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRhdGE7XHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH07XHJcblxyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQ6IFJlY2VpdmluZ0ZpbGUgPSB7XHJcbiAgICAgICAgICAgICAgICBzaXplOiBpdGVtLnNpemUsXHJcbiAgICAgICAgICAgICAgICBzcGxpdE51bWJlcjogaXRlbS5zcGxpdE51bWJlcixcclxuICAgICAgICAgICAgICAgIG5hbWU6IGl0ZW0ubmFtZSxcclxuICAgICAgICAgICAgICAgIG9uRGF0YTogYXN5bmMgKGNhbGxiYWNrLCBzdGFydEluZGV4ID0gMCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdGFydCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAoPGFueT5jYWxsYmFjaykobmV3IEVycm9yKCfkuI3lj6/ph43lpI3kuIvovb3mlofku7YnKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc3RhcnQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpbmRleCA9IHN0YXJ0SW5kZXggLSAxO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgd2hpbGUgKHRydWUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGRhdGEgPSBhd2FpdCBkb3dubG9hZE5leHQoKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKDxhbnk+Y2FsbGJhY2spKGVycm9yKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGF0YSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGlzTmV4dCA9IGF3YWl0IGNhbGxiYWNrKHVuZGVmaW5lZCwgZmFsc2UsIGluZGV4LCBkYXRhKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOZXh0ID09PSB0cnVlKSBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sodW5kZWZpbmVkLCB0cnVlLCBpbmRleCwgQnVmZmVyLmFsbG9jKDApKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICBnZXRGaWxlOiBhc3luYyAoKSA9PiB7ICAgLy/kuIvovb3mlofku7blm57osINcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3RhcnQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkuI3lj6/ph43lpI3kuIvovb3mlofku7YnKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzdGFydCA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVQaWVjZXM6IEJ1ZmZlcltdID0gW107ICAgIC8v5LiL6L295Yiw55qE5paH5Lu254mH5q61XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICB3aGlsZSAodHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IGRvd25sb2FkTmV4dCgpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChkYXRhKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmlsZVBpZWNlcy5wdXNoKGRhdGEpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gQnVmZmVyLmNvbmNhdChmaWxlUGllY2VzKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgZGF0YTogeyBkYXRhOiBtc2cuZGF0YSwgZmlsZXMgfSxcclxuICAgICAgICAgICAgY2xlYW46ICgpID0+IHsgLy/muIXnkIbmraPlnKjkuIvovb3nmoRcclxuICAgICAgICAgICAgICAgIGNsZWFuZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5fbWVzc2FnZUxpc3RlbmVyLnRyaWdnZXJEZXNjZW5kYW50cyhbTWVzc2FnZVR5cGUuaW52b2tlX2ZpbGVfZmFpbGVkLCBtc2cuc2VuZGVyLCBtZXNzYWdlSURdIGFzIGFueSwgeyBlcnJvcjogJ+S4i+i9vee7iOatoicgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgfVxyXG59Il19
