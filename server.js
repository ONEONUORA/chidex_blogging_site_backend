import express, { json } from "express";
import mongoose from "mongoose";
import 'dotenv/config'
import bcrypt from "bcrypt"
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken"
import cors from 'cors';
import admin from "firebase-admin";
import serviceAccountKey from './chidex.json' assert{type: 'json'}
import {getAuth} from "firebase-admin/auth"
import aws from "aws-sdk";




///schema********************************************************************************
import User from "./schema/User.js";
import Blog from "./schema/Blog.js";
import Notification from "./schema/Notification.js"
import Comment from "./schema/Comment.js"

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const server = express();
const PORT= 3000;



admin.initializeApp({
    credential: admin.credential.cert(serviceAccountKey)
})

let emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
let passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());
server.use(cors({ origin: allowedOrigin }));

mongoose.connect(process.env.DB_LOCATION,{
    autoIndex: true
})


//setting up aws to add and remove object ********************************************

const s3 = new aws.S3({
    region:'eu-north-1',
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
})

const generateUploadURL = async()=>{

    const date = new Date();
    const imageName = `${nanoid()}-${date.getTime()}.jpeg`;

   return await s3.getSignedUrlPromise('putObject',{
        Bucket:'blogging',
        Key: imageName,
        Expires: 1000,
        ContentType:'image/jpeg'
    })


}

/////////////////////////////////////////*************jwt verification************ */
const verifyJWT = (req, res, next) =>{

        const authHeader = req.headers["authorization"];
        const token = authHeader &&  authHeader.split(" ")[1]; 

        if (token == null){
            return res.status(401).json({error: "No Access Token"})
        } 

        jwt.verify(token, process.env.SECRET_ACCESS_KEY , (err, user) =>{
            if(err) {
                return res.status(403).json({ error: "Access token is invalid"})
            }
            req.user = user.id
            next()
        })
}


/**********************data to see in the session******************************************* */
const formatDatatoSend = (user) => {
    const access_token = jwt.sign({ id: user._id }, process.env.SECRET_ACCESS_KEY )
    return{
        access_token,
        profile_img: user.personal_info.profile_img,
        username: user.personal_info.username,
        fullname: user.personal_info.fullname
    }
}

const generateUsername = async (email) =>{

    let username = email.split("@")[0]; 
    let isUsernameNotUnique = await User.exists({"personal_info.username": username}).then((result) => result)
     isUsernameNotUnique ? username += nanoid().substring(0, 3) : "";
    return username
}




//Upload image route with aws********************************************************************

server.get('/get-upload-url', (req, res)=>{
    generateUploadURL().then(url => res.status(200).json({uploadURL: url}))
    .catch(err =>{
        console.log(err.message);
        return res.status(500).json({error: err.message})
    })
})

////signup  post request***********************************************************************


server.post("/api/v1/user/signup", (req, res)=>{
  
    let {fullname, email, password} = req.body;

   
    //validating data from frontend*********************************************************************

    if(fullname.length < 3){
        return res.status(403).json({"error": "Fullname must be at least 3 letters long"})
    }


    if(!email.length){
        return res.status(403).json({"error": "Enter Email"})
    }

    if(!emailRegex.test(email)){
        return res.status(403).json({ "error":"Email is Invalid"})
    }

    if(!passwordRegex.test(password)){
        return res.status(403).json({"error": "Password should be 6 - 20 characters long with a numeric, 1 lowercase and 1 uppercase letters "}) 
    }

    bcrypt.hash(password, 10, async (err, hashed_password)=>{

            let username = await generateUsername(email);

            let user = new User({
                personal_info:{ fullname, email, password: hashed_password, username}
            })

            user.save().then((u) =>{
                return res.status(200).json(formatDatatoSend(u))
            })

            .catch(err =>{

                if(err.code == 11000){
                    return res.status(500).json({"error": "Email Already Exists"})
                }
                return res.status(500).json({"error": err.message})
            })

    
    })
 
})


//signin post request------**************************************************************************

server.post("/api/v1/user/signin", (req, res)=> {

    let { email, password} = req.body;
    
    User.findOne({ "personal_info.email": email})
    .then((user) => {

        if(!user){
            return res.status(403).json({"error": "Email not found"})
        }

        if(!user.google_auth){

            bcrypt.compare(password, user.personal_info.password, (err, result) =>{

                if(err) {
                    return res.status(403).json({"error": "Error Occured while trying to login please try again"});
                }
    
                if(!result){
                    return res.status(403).json({"error": "Incorrect Password"})
                }else{
                    return res.status (200).json(formatDatatoSend(user))
                }
    
    
            })
            
        }else{
            return res.status(403).json({'error': "Account was created using google. Try login with Google."})
        }

   
    
    })

    .catch(err =>{
        console.log(err.message)
        return res.status(500).json({"error": err.message})
    })
})


//google  authenication**********************************************************************

server.post('/google-auth', async (req, res) =>{
    let {access_token} = req.body;

    getAuth()
    .verifyIdToken(access_token)
    .then(async (decodedUser) =>{


        let { email, name, picture} = decodedUser;

        picture = picture.replace("s96-c", "s384-c");

        let user = await User.findOne({"personal_info.email": email}).select("personal_info.fullname personal_info.username personal_info.profile_img google_auth")
            .then((u) =>{
                return u || null
            })

            .catch(err => {
                return res.status(500).json({"error" : err.message})
            })

            if(user) {//sign in 
                if(!user.google_auth){
                    return res.status(403).json({"error": "This account was signed up without google. Please log in with password to access the account"})
                }

            }
            else{//sign up

                let username = await generateUsername(email)
                user = new User ({
                    personal_info: {fullname: name, email, username},
                    google_auth: true
                })

                await user.save().then((u) =>{
                    user = u;
                })
                .catch(err =>{
                    return res.status(500).json({"error": err.message})
                })
            }

            return res.status(200).json(formatDatatoSend(user))
    })

    .catch(err => {
        return res.status(500).json({"error": "Failed to authenicate you with google. Try with some other google account"})
    })

})

/************************************************route to change password************************************************************************** */

server.post("/api/v1/user/change-password", verifyJWT, (req,res)=>{
  let  { currentPassword, newPassword} = req.body;

  if(!passwordRegex.test(currentPassword) || !passwordRegex.test(newPassword)){
    return res.status(403).json({ error:"Password should be 6 - 20 characters long with a numeric, 1 lowercase and 1 uppercase letters "})
    }

    User.findOne({_id: req.user})
    .then((user) =>{
        if(user.google_auth){
            return res.status(403).json({error: "You can't change password, You registered your account using google."})
        }

        bcrypt.compare(currentPassword, user.personal_info.password, (err, result) =>{
            if(err) {
                return res.status(500).json({error: "Some error occured while changing the password, Please try again later" })
            }

            if(!result){
                return res.status(403).json({ error: "Incorrect current password"  })
            }

            bcrypt.hash(newPassword, 10 , (err, hashed_password) =>{

                User.findOneAndUpdate({_id: req.user}, {"personal_info.password": hashed_password})
                .then((u) =>{
                    return res.status(200).json({status: 'Password Changed'})
                })
                .catch(err =>{
                    return res.status(500).json({error: "Some error occured while saving new password, Please try again later."})
                })
            })

        
        })
    })
    .catch(err => {
        console.log(err);
        res.status(500).json({error: "User not found"})
    })
})

//*********************************route to get latest blog to from the database**********************************************************

server.post("/latest-blogs", (req, res) => {

    let { page } = req.body;

     let maxLimit = 5;

     Blog.find({draft: false})
    .populate("author", " personal_info.profile_img personal_info.username personal_info.fullname  -_id")
    .sort({"publishedAt": -1})
    .select("blog_id title des banner activity tags  publishedAt -_id")
    .skip((page - 1 ) * maxLimit)
    .limit(maxLimit)
    .then(blogs => {
        return res.status(200).json({ blogs })
    })
    .catch(err => {
        return res.status(500).json ({ error: err.message})
    })

})

/*******************************************************route to get all blog* latest count****************************** */
server.post('/all-latest-blogs-count', (req, res) => {

    Blog.countDocuments({ draft: false })
    .then(count => {
        return res.status(200).json({ totalDocs: count })
    })

    .catch(err =>{
        console.log(err.message);
        return res.status(500).json({ error: err.message })
    })
})

/****************************route to get trending blog from the database**************************** */

server.get('/trending-blogs', (req, res) =>{
    Blog.find({ draft: false })
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname  -_id")
    .sort({ "activity.total_reads": -1, "activity.total_likes": -1, "publishedAt": -1 })
    .select("blog_id title publishedAt -_id")
    .limit(5)
    .then(blogs => {
        return res.status(200).json({ blogs })
    })
    .catch(err => {
        return res.status(500).json({ error: err.message })
    })
})

/************************************route for filter and search  of blogs *********************/

server.post('/search-blogs', (req, res) =>{
    
        let { tag ,query, author,  page , limit, eliminate_blog} = req.body;
        let findQuery;
        
        if(tag){
             findQuery = { tags: tag, draft: false, blog_id:{ $ne: eliminate_blog}};
        }else if(query){
            findQuery = {draft: false, title: new RegExp(query, 'i')}

        }else if(author){
            findQuery = { author, draft: false}
        }

        let maxLimit = limit ?  limit : 2;

        Blog.find(findQuery)
        
        .populate("author", " personal_info.profile_img personal_info.username personal_info.fullname  -_id")
         .sort({"publishedAt": -1})
         .select("blog_id title des banner activity tags  publishedAt -_id")
         .skip( (page - 1 ) * maxLimit)
         .limit(maxLimit)
         .then(blogs => {
         return res.status(200).json({ blogs })
        })
         .catch(err => {
           return res.status(500).json ({ error: err.message})
        })


})

/*****************************************route to get all search blog count***************************** */

server.post("/search-blogs-count", (req, res) => {

    let { tag , author, query} = req.body;
    
    let findQuery;
    
    if(tag){
        findQuery = { tags: tag, draft: false };
   }else if(query){
       findQuery = {draft: false, title: new RegExp(query, 'i')}
   }else if(author){
    findQuery = { author, draft: false}
   }

    Blog.countDocuments(findQuery)
    .then (count => {
        return res.status(200).json( { totalDocs: count } )
    })
    .catch(err =>{
        console.log(err.message)
        return res.status(500).json( {error: err.message} )
    })
})

/** ***********************************************searching user route************************************ */

server.post("/search-users",  (req, res)=>{
    let { query }  = req.body;

    User.find({"personal_info.username": new RegExp(query, "i")})
    .limit(50)
    .select("personal_info.fullname personal_info.username personal_info.profile_img -_id")
    .then(users => {
        return res.status(200).json({ users })
    })
    .catch(err =>{
        return res.status(500).json({error: err.message})
    })
})

/********************************************profile page route********************************* */

server.post("/get-profile", (req, res) =>{

    let { username } = req.body;
    User.findOne({"personal_info.username": username})
    .select("-personal_info.password -google_auth -updatedAt -blogs")
    .then(user => {
        return res.status(200).json(user)
    })
    .catch(err => {
        console.log(err);
        return res.status(500).json({error: err.message})
    }

    )
})



//***********************************************upload image route************************************************************************************* */
server.post("/update-profile-img", verifyJWT , (req,res) =>{

    let {url} = req.body;

    User.findOneAndUpdate({_id: req.user}, {"personal_info.profile_img": url})
    .then(() => {
        return res.status(200).json({ profile_img: url })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

//************************************************update profile route************************************************************************** */
server.post("/update-profile", verifyJWT, (req,res) =>{
    let {username, bio, social_links} = req.body;

    let bioLimit = 150
    if(username.length < 3 ){
        return res.status(403).json({ error: "Username must be more than 3 letters long." })
    }

    if(bio.length > bioLimit){
        return res.status(403).json({error: `Bio should not be more than ${bioLimit} characters`})
    }

    let socialLinksArr = Object.keys(social_links);

    try{
        for(let i = 0; i < socialLinksArr.length; i++){
            if(social_links[socialLinksArr[i]].length){
                let hostname = new URL(social_links[socialLinksArr[i]]).hostname;

                if(!hostname.includes(`${socialLinksArr[i]}.com`) && socialLinksArr[i] != 'website'){
                    return res.status(403).json({error: `${socialLinksArr[i]} link is invalid. You must enter a full valid link`})
                }
            }
        }

    } catch(err) {
        return res.status(500).json({error: " You must provide full social links with http(s) included"})
    }

    let updateObj = {
        "personal_info.username": username,
        "personal_info.bio": bio,
        social_links
    }

    User.findOneAndUpdate({ _id: req.user }, updateObj, {
        runValidators: true
    })
    .then(() => {
        return res.status(200).json({username})
    })
    .catch(err =>{
        if(err.code == 11000){
            return res.status(409).json({error: "Username is already taken"})
        }

        return res.status(500).json({ error: err.message })
    })
})
// **********************************************create blog server route********************************************************************
    
server.post('/create-blog', verifyJWT, (req, res) => {
    let authorId = req.user;
    let { title, des, banner, tags, content, draft, id } = req.body;

    if (!title || !title.length) {
        return res.status(403).json({ error: "You must provide a title" });
    }

    if (!draft) {
        if (!des || !des.length || des.length > 200) {
            return res.status(403).json({ error: "You must provide a blog description under 200 characters" });
        }

        if (!banner || !banner.length) {
            return res.status(403).json({ error: "You must provide a blog banner before you can publish the blog" });
        }

        if (!content || !content.blocks || !content.blocks.length) {
            return res.status(403).json({ error: "There must be some blog content before you can publish it" });
        }

        if (!tags || !tags.length || tags.length > 10) {
            return res.status(403).json({ error: "Provide some tags in order to publish the blog, Maximum 10" });
        }
    }

    tags = tags.map(tag => tag.toLowerCase());

    let blog_id = id || title.replace(/[^a-zA-Z0-9]+/g, ' ').replace(/\s+/g, "-").trim() + nanoid();

    if (id) {
        Blog.findOneAndUpdate({ blog_id }, { title, des, banner, content, tags, draft: draft ? draft : false })
            .then(() => {
                return res.status(200).json({ id: blog_id });
            })
            .catch(err => {
                return res.status(500).json({ error: err.message });
            });

    } else {
        let blog = new Blog({
            title, des, banner, content, tags, author: authorId, blog_id, draft: Boolean(draft)
        });

        blog.save().then(blog => {
            let incrementVal = draft ? 0 : 1;

            User.findOneAndUpdate({ _id: authorId }, { $inc: { "account_info.total_posts": incrementVal }, $push: { "blogs": blog._id } })
                .then(user => {
                    return res.status(200).json({ id: blog.blog_id });
                })
                .catch(err => {
                    return res.status(500).json({ error: "Failed to update total posts number" });
                });
        })
        .catch(err => {
            return res.status(500).json({ error: err.message });
        });
    }
});


   
/**************************************route to get blog from the database whenever a user clicks on a blogpost on the home page************************************************************ */

server.post("/get-blog", (req, res)=>{

    let { blog_id, draft, mode } = req.body;

    let incrementVal = mode != 'edit' ?  1  : 0 ;

    Blog.findOneAndUpdate({ blog_id }, { $inc : { "activity.total_reads": incrementVal } })
    .populate("author", "personal_info.fullname personal_info.username personal_info.profile_img")
    .select('title des content banner activity publishedAt blog_id tags')
    .then(blog => {
        User.findOneAndUpdate({"personal_info.username": blog.author.personal_info.username},{
            $inc : { "account_info.total_reads": incrementVal}
        })

        .catch(err => {
            return res.status(500).json({ error: err.message})
        })

        if(blog.draft && !draft){
            return res.status(500).json({error: 'You can not access draft blog'})
        }
           

        return res.status(200).json({ blog });
    })
    .catch(err =>{
        return res.status(500).json({error: err.message});
    })
})

/*******************************************************route to send liked blog to the database/****************************** */ 


server.post("/like-blog", verifyJWT , (req, res)=>{

    let user_id = req.user;
    let { _id, islikedByUser} = req.body;
    let incrementVal = !islikedByUser ? 1 : -1;
    Blog.findOneAndUpdate({ _id }, {$inc: {"activity.total_likes": incrementVal}})
    .then(blog => {

        if(!islikedByUser){
                let like = new Notification({
                    type: "like",
                    blog: _id,
                    notification_for: blog.author,
                    user: user_id
                })

                like.save().then(notification => {
                    return res.status(200).json({ liked_by_user: true })
                })
        }else{
            Notification.findOneAndDelete({user: user_id, blog: _id,  type: "like"})
            .then(data =>{
                return res.status(200).json({liked_by_user: false})
            })
            .catch(err => {
                return res.status(500).json({error: err.message })
            })
        }
    })

})

server.post("/isliked-by-user", verifyJWT , (req,res)=>{
        let user_id = req.user;
        let { _id } = req.body;
        Notification.exists({ user: user_id, type: 'like', blog: _id })
        .then(result =>{
            return res.status(200).json({result})
        })
        .catch(err =>{
            return res.status(500).json({error: err.message})
        })
})


/*****************************************************************route to comment on a blog********************************************************* */
server.post("/add-comment", verifyJWT, (req, res) =>{

    let user_id = req.user;

    let { _id, comment,  blog_author, replying_to, notification_id } = req.body;

    if(!comment.length){
        return res.status(403).json({error: "Write something to leave a comment"});
    }

    //creating comment doc

    let commentObj = {
        blog_id: _id, blog_author, comment, commented_by: user_id,
    }


    if(replying_to){
        commentObj.parent = replying_to;
        commentObj.isReply = true;
    }

    new Comment(commentObj).save().then(async commentFile =>{

        let {comment, commentedAt, children} = commentFile;

        Blog.findOneAndUpdate({_id}, { $push: {"comments": commentFile._id}, 
         $inc:{"activity.total_comments": 1, "activity.total_parent_comments": replying_to ? 0 : 1}, } )
        .then(blog => { console.log("New comment created") });

        let notificationObj = {
            type:  replying_to ? "reply" :'comment',
            blog: _id,
            notification_for: blog_author,
            user: user_id,
            comment: commentFile._id
        }

        if(replying_to){

            notificationObj.replied_on_comment = replying_to;

            await Comment.findOneAndUpdate({ _id: replying_to}, {$push: { children: commentFile._id } } )
            .then(replyingTocommentDoc => { notificationObj.notification_for = replyingTocommentDoc.commented_by })

            if(notification_id){
                Notification.findOneAndUpdate({ _id: notification_id }, {reply: commentFile._id})
                .then(notification => console.log('notification updated'))

            }
        }

        new Notification(notificationObj).save().then(notification => console.log("New notification created"));

        return res.status(200).json({
            comment, commentedAt, _id: commentFile._id, user_id, children
        })
    })

    

})
/***************************************************************route to get comment on blog*************************************************************** */
server.post("/get-blog-comments", (req, res) =>{

    let { blog_id, skip }  = req.body;

    let maxLimit = 5;

    Comment.find({ blog_id, isReply: false})
    .populate("commented_by", "personal_info.username personal_info.fullname personal_info.profile_img")
    .skip(skip)
    .limit(maxLimit)
    .sort({
        //get the latest comment first (-1)
        'commentedAt': -1
    })
    .then(comment => {
        return res.status(200).json(comment)
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({ error: err.message })
    })
})

/******************************************************Hide reply route**************************************************************** */

server.post("/get-replies", (req,res) =>{
    let {_id, skip} = req.body;
    let maxLimit = 5;

    Comment.findOne({_id})
    .populate({
        path: "children",
        options:{
            limit: maxLimit,
            skip: skip,
            sort : {"commentedAt" : -1}
        },
        populate:{
            path: "commented_by",
            select: "personal_info.profile_img personal_info.fullname personal_info.username"
        },
        select: "-blog_id -updatedAt"
    })
    .select("children")
    .then(doc =>{
        return res.status(200).json({replies: doc.children})
    })
    .catch(err => {
        return res.status(500).json({ error: err.message })
    })
})

// /**/***************************************************route to delete comments/replies****************************************************** */ 

const deleteComments =(_id) =>{
    Comment.findOneAndDelete({ _id})
    .then(comment =>{

        if(comment.parent){
            Comment.findOneAndUpdate({ _id:comment.parent }, {$pull: {children: _id}})
            .then(data => console.log('comment delete from parent'))
            .catch(err => console.log(err))
        }
        Notification.findOneAndDelete({ comment:_id}).then(notification => console.log("comment notification deleted"))
        Notification.findOneAndUpdate({reply: _id}, {$unset: {reply: 1} }).then(notification => console.log("reply notification deleted"))
//1 means true
        Blog.findOneAndUpdate({ _id: comment.blog_id }, {$pull: {comments: _id}, $inc:{"activity.total_comments": -1} , "activity.total_parent_comments":  comment.parent ? 0 : -1})
        .then(blog => {
            if(comment.children.length){
                comment.children.map(replies => {
                    deleteComments(replies)
                })
            }
        })
    })

    .catch(err => {
        console.log(err.message)
    })
}


server.post("/delete-comment",verifyJWT, (req, res) =>{

        let user_id = req.user;
        let {_id}  = req.body;

        Comment.findOne({ _id })
        .then(comment =>{
            if(user_id == comment.commented_by || user_id == comment.blog_author){

                deleteComments(_id)
                    return res.status(200).json({ status: "done"});

            }else{
                return res.status(403).json({error: "You can not delete this comment !!!"})
            }
        })

})

/**********************************************************notification alert route**************************************************- */
server.get("/new-notification", verifyJWT, (req, res) =>{
    let user_id = req.user;
    Notification.exists({ notification_for: user_id, seen: false, user: { $ne: user_id }  })
    .then(result => {
        if(result){
            return res.status(200).json({ new_notification_available: true})
        }else{
            return res.status(200).json({ new_notification_available: false })
        }
    })
    .catch(err =>{
        console.log(err.message);
        return res.status(500).json({ error: err.message })
    })
})

/*********************************************************NOTIFICATION FILTER ROUTE*********************************************************************** */
server.post("/notifications", verifyJWT , (req, res) => {
    let user_id = req.user;
    let { page, filter, deletedDocCount} = req.body;
    let maxLimit = 10;
    let findQuery = {notification_for: user_id, user: {$ne: user_id}}
    let skipDocs = (page - 1) * maxLimit;

    if(filter != 'all'){
        findQuery.type = filter;
    }

    if(deletedDocCount){
        skipDocs -= deletedDocCount;
    }

    Notification.find(findQuery)
    .skip(skipDocs)
    .limit(maxLimit)
    .populate("blog", "title blog_id")
    .populate("user", "personal_info.fullname personal_info.username personal_info.profile_img")
    .populate("comment", "comment")
    .populate("replied_on_comment", "comment")
    .populate("reply", "comment")
    .sort({ createdAt: -1  })
    .select("createdAt type seen reply")
    .then(notifications => {

        Notification.updateMany(findQuery, {seen: true})
        .skip(skipDocs)
        .limit(maxLimit)
        .then(() => console.log("notification seen"))
        return res.status(200).json({ notifications })
    })
    .catch(err =>{
        console.log(err.message);
        return res.status(500).json({error: err.message})
    })
})

/***************************************************notification count route*************************************************************************** */

server.post("/all-notifications-count" , verifyJWT, (req,res) => {
                 let user_id = req.user;
                 let { filter }  = req.body;
                 let findQuery = {notification_for: user_id, user: {$ne: user_id} }

                 if(filter != 'all'){
                    findQuery.type = filter;
                 }

                 Notification.countDocuments(findQuery)
                 .then(count => {
                    return res.status(200).json({totalDocs: count})
                 })
                 .catch(err => {
                    return res.status(500).json({ error: err.message })
                 })


})
/****************************************************route to get save draft and published blog to display on the user dashboard*************************************************************************** */

server.post("/user-written-blogs", verifyJWT, (req,res) => {

let user_id = req.user;
let { page, draft, query, deletedDocCount } = req.body
 let maxLimit = 5;
 let skipDocs = (page - 1) * maxLimit;

 if(deletedDocCount){
    skipDocs -= deletedDocCount
 }

 Blog.find({ author: user_id, draft, title: new RegExp(query, "i") })
 .skip(skipDocs)
 .limit(maxLimit)
 .sort({ publishedAt: -1 })
 .select("title banner publishedAt blog_id activity des draft -_id")
 .then(blogs => {
    return res.status(200).json({ blogs })
 })
 .catch(err => {
    return res.status(500).json({ error: err.message })
 })

})

/********************************************route for user-written-blogs-count ************************************************************************************* */
server.post("/user-written-blogs-count", verifyJWT, (req,res) => {
    let user_id = req.user
    let {draft, query} = req.body
    Blog.countDocuments({author: user_id, draft, title: new RegExp(query, "i") })
    .then(count => {
        return res.status(200).json({ totalDocs: count})
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({error: err.message});
    })
})


/*******************************************************route to delete blog********************************************************************** */
server.post("/delete-blog", verifyJWT, (req, res) =>{

    let user_id = req.user;
    let { blog_id } = req.body;

    Blog.findOneAndDelete({ blog_id })
    .then(blog =>{
        
        Notification.deleteMany({ blog: blog._id }).then(data => console.log("notifications Deleted"));

        Comment.deleteMany({ blog_id: blog._id }).then(data => console.log('Comments deleted'));

        User.findOneAndUpdate({_id: user_id}, {$pull: {blog: blog._id}, $inc:{ "account_info.total_posts": -1 }})
        .then(user => console.log("Blog deleted"));
        return res.status(200).json({ status: 'done' })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

/**********************************************************************port configuration******************************************** */

server.listen(PORT, () =>{
    console.log("server is listening on port ->" + PORT)
})
