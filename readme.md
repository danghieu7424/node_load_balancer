___
### Thêm kiểm tra healthz vào mỗi server
```js
app.get('/healthz', (req, res) => {
    res.status(200).send();
})
```
___